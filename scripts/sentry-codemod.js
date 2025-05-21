module.exports = function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  // Add import declaration if not present
  const hasImport = root.find(j.ImportDeclaration, { source: { value: "@sentry/nextjs" } }).size() > 0;
  if (!hasImport) {
    const importDecl = j.importDeclaration(
      [j.importNamespaceSpecifier(j.identifier("Sentry"))],
      j.literal("@sentry/nextjs")
    );
    root.get().node.program.body.unshift(importDecl);
  }

  // Insert Sentry.captureException in catch blocks
  root.find(j.CatchClause).forEach(path => {
    const catchParam = path.value.param;
    if (!catchParam || !catchParam.name) return;
    const errorName = catchParam.name;
    const captureCall = j.expressionStatement(
      j.callExpression(
        j.memberExpression(j.identifier("Sentry"), j.identifier("captureException")),
        [j.identifier(errorName)]
      )
    );
    // only insert if not already present
    const bodyStatements = path.value.body.body;
    const alreadyInserted = bodyStatements.some(stmt =>
      j(stmt).find(j.CallExpression, {
        callee: {
          object: { name: "Sentry" },
          property: { name: "captureException" }
        }
      }).size() > 0
    );
    if (!alreadyInserted) {
      bodyStatements.unshift(captureCall);
    }
  });

  return root.toSource({ quote: 'double' });
}; 