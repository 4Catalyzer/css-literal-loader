import { dirname, relative } from 'path';
import groupBy from 'lodash/groupBy';
import uniq from 'lodash/uniq';
import resolve from 'resolve';

import getNameFromPath from './getNameFromPath';

const rComposes = /\b(?:composes\s*?:\s*([^;>]*?)(?:from\s(.+?))?(?=[;}/\n\r]))/gim;
const rPlaceholder = /###ASTROTURF_PLACEHOLDER_\d*?###/g;

function defaultResolveDependency({ request }, localStyle) {
  const source = resolve.sync(request, {
    baseDir: dirname(localStyle.absoluteFilePath),
  });

  return { source };
}

function resolveMemberExpression(path) {
  let nextPath = path.resolve();
  while (nextPath && nextPath.isMemberExpression()) {
    nextPath = nextPath.get('object').resolve();
  }
  return nextPath;
}

function resolveImport(path) {
  const resolvedPath = resolveMemberExpression(path);
  const binding = resolvedPath.scope.getBinding(resolvedPath.node.name);
  if (!binding || binding.kind !== 'module') return false;

  const importPath = binding.path;
  const parent = importPath.parentPath;
  if (!parent.isImportDeclaration()) return null;

  const request = parent.node.source.value;
  let identifier;

  if (importPath.isImportNamespaceSpecifier()) {
    if (!path.isMemberExpression()) throw new Error('this is weird');
    identifier = getNameFromPath(path.get('property'));
  } else if (importPath.isImportDefaultSpecifier()) {
    identifier = getNameFromPath(resolvedPath);
  } else if (importPath.isImportSpecifier()) {
    // TODO: this isn't correct doesn't do member expressions
    identifier = getNameFromPath(importPath.get('imported'));
  }

  return { identifier, request, type: importPath.node.type };
}

function resolveInterpolation(
  path,
  nodeMap,
  localStyle,
  resolveDependency = defaultResolveDependency,
) {
  const resolvedPath = resolveMemberExpression(path);

  const style = resolvedPath && nodeMap.get(resolvedPath.node);

  if (style) {
    return {
      imported: !style.isStyledComponent
        ? path.get('property').node.name
        : 'cls1',
      source: relative(
        dirname(localStyle.absoluteFilePath),
        style.absoluteFilePath,
      ),
    };
  }

  if (resolveDependency) {
    const resolvedImport = resolveImport(path);

    if (resolvedImport) {
      const { identifier } = resolvedImport;
      const interpolation =
        resolveDependency(resolvedImport, localStyle, path.node) || null;

      const isStyledComponent =
        interpolation.isStyledComponent == null
          ? identifier.toLowerCase()[0] !== identifier[0]
          : interpolation.isStyledComponent;

      return (
        interpolation && {
          imported: !isStyledComponent
            ? path.get('property').node.name
            : 'cls1',
          ...interpolation,
        }
      );
    }
  }
  return null;
}

const getPlaceholder = idx => `###ASTROTURF_PLACEHOLDER_${idx}###`;

export default (
  quasiPath,
  nodeMap,
  localStyle,
  { tagName, resolveDependency },
) => {
  const quasi = quasiPath.node;

  const interpolations = new Map();
  const expressions = quasiPath.get('expressions');

  let text = '';
  quasi.quasis.forEach((tmplNode, idx) => {
    const { cooked } = tmplNode.value;
    const expr = expressions[idx];

    text += cooked;

    if (expr) {
      const result = expr.evaluate();

      if (result.confident) {
        text += result.value;
        return;
      }

      // TODO: dedupe the same expressions in a tag
      const interpolation = resolveInterpolation(
        expr,
        nodeMap,
        localStyle,
        resolveDependency,
      );

      if (!interpolation) {
        throw expr.buildCodeFrameError(
          `Could not resolve interpolation to a value, ${tagName} returned class name, or styled component. ` +
            'All interpolated styled components must be in the same file and values must be statically determinable at compile time.',
        );
      }

      interpolation.expr = expr;
      const ph = getPlaceholder(idx);
      interpolations.set(ph, interpolation);
      text += ph;
    }
  });

  // Replace references in `composes` rules
  text = text.replace(rComposes, (composes, classNames, fromPart) => {
    const classList = classNames.replace(/(\n|\r|\n\r)/, '').split(/\s+/);

    const composed = classList
      .map(className => interpolations.get(className))
      .filter(Boolean);

    if (!composed.length) return composes;

    if (fromPart) {
      // don't want to deal with this case right now
      throw classList[0].expr.buildCodeFrameError(
        'A styled interpolation found inside a `composes` rule with a "from". ' +
          'Interpolated values should be in their own `composes` without specifying the file.',
      );
    }
    if (composed.length < classList.length) {
      throw classList[0].expr.buildCodeFrameError(
        'Mixing interpolated and non-interpolated classes in a `composes` rule is not allowed.',
      );
    }

    return Object.entries(groupBy(composed, i => i.source)).reduce(
      (acc, [source, values]) => {
        const classes = uniq(values.map(v => v.imported)).join(' ');
        return `${
          acc ? `${acc};\n` : ''
        }composes: ${classes} from "${source}"`;
      },
      '',
    );
  });

  let id = 0;
  let imports = '';
  text = text.replace(rPlaceholder, match => {
    const { imported, source } = interpolations.get(match);
    const localName = `a${id++}`;

    imports += `@value ${imported} as ${localName} from "${source}";\n`;
    return `.${localName}`;
  });

  if (imports) imports += '\n\n';

  return {
    text,
    imports,
  };
};
