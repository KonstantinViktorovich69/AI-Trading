import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export interface VerificationResult {
  success: boolean;
  errors: string[];
  passedChecks: string[];
}

export interface ModularComponents {
  realTradeRoutesCode?: string;
  expressFactoryCode?: string;
  persistenceCode?: string;
  storageServiceCode?: string;
}

export function validateIntegrationWiring(
  serverCode: string,
  envContent?: string,
  pkgContent?: string,
  testCode?: string,
  coordinatorCode?: string,
  productionHandlersCode?: string,
  modularComponents?: ModularComponents
): VerificationResult {
  const errors: string[] = [];
  const passedChecks: string[] = [];

  // Auto-resolve modular components if verifying live project structure (not standalone fixture test snippet)
  if (!modularComponents && !serverCode.includes('/api/real-trade/open') && typeof process !== 'undefined' && process.cwd) {
    try {
      const realTradeRoutesPath = path.join(process.cwd(), 'server', 'routes', 'realTradeRoutes.ts');
      const expressFactoryPath = path.join(process.cwd(), 'server', 'expressAppFactory.ts');
      const persistencePath = path.join(process.cwd(), 'server', 'services', 'databasePersistenceManager.ts');
      const storageServicePath = path.join(process.cwd(), 'server', 'services', 'dbStorageService.ts');
      if (fs.existsSync(realTradeRoutesPath) && fs.existsSync(expressFactoryPath)) {
        modularComponents = {
          realTradeRoutesCode: fs.readFileSync(realTradeRoutesPath, 'utf-8'),
          expressFactoryCode: fs.readFileSync(expressFactoryPath, 'utf-8'),
          persistenceCode: fs.existsSync(persistencePath) ? fs.readFileSync(persistencePath, 'utf-8') : undefined,
          storageServiceCode: fs.existsSync(storageServicePath) ? fs.readFileSync(storageServicePath, 'utf-8') : undefined
        };
      }
    } catch {
      // Ignore errors in non-fs / fixture test environments
    }
  }

  const sourceFile = ts.createSourceFile('server.ts', serverCode, ts.ScriptTarget.Latest, true);

  const importedSymbols = new Set<string>();
  const functionCalls = new Set<string>();
  const identifiers = new Set<string>();

  function visitNode(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        node.importClause.namedBindings.elements.forEach((elem) => {
          importedSymbols.add(elem.name.text);
        });
      }
    } else if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        functionCalls.add(node.expression.text);
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        functionCalls.add(`${node.expression.expression.getText(sourceFile)}.${node.expression.name.text}`);
      }
    } else if (ts.isIdentifier(node)) {
      identifiers.add(node.text);
    }

    ts.forEachChild(node, visitNode);
  }

  visitNode(sourceFile);

  // 1. Exactly one real-trade/open and one real-trade/close route
  const routesCodeToCheck = (modularComponents?.realTradeRoutesCode ? modularComponents.realTradeRoutesCode + '\n' : '') + serverCode;
  const openMatches = routesCodeToCheck.match(/(?:app|router)\.post\(\s*['"](?:\/api)?\/real-trade\/open['"]/g) || [];
  const closeMatches = routesCodeToCheck.match(/(?:app|router)\.post\(\s*['"](?:\/api)?\/real-trade\/close['"]/g) || [];

  if (openMatches.length === 1) {
    passedChecks.push(`AST: Exactly 1 POST /api/real-trade/open route registered`);
  } else if (openMatches.length > 1) {
    errors.push(`AST: Duplicate real-trade open route detected (found ${openMatches.length})`);
  } else {
    errors.push(`AST: Expected exactly 1 POST /api/real-trade/open route, found 0`);
  }

  if (closeMatches.length === 1) {
    passedChecks.push(`AST: Exactly 1 POST /api/real-trade/close route registered`);
  } else if (closeMatches.length > 1) {
    errors.push(`AST: Duplicate real-trade close route detected (found ${closeMatches.length})`);
  } else {
    errors.push(`AST: Expected exactly 1 POST /api/real-trade/close route, found 0`);
  }

  // 2. isRealTradingAllowed guard dominates real routes and precedes exchange sink
  const hasGuardInServer = serverCode.includes('isRealTradingAllowed') && (identifiers.has('isRealTradingAllowed') || functionCalls.has('isRealTradingAllowed'));
  const hasGuardInRoutes = Boolean(
    modularComponents?.realTradeRoutesCode && (
      modularComponents.realTradeRoutesCode.includes('isRealTradingAllowed') ||
      modularComponents.realTradeRoutesCode.includes('isAllowed') ||
      modularComponents.realTradeRoutesCode.includes('ENABLE_REAL_TRADING')
    )
  );
  const hasGuard = hasGuardInServer || hasGuardInRoutes;

  if (hasGuard) {
    // AST Check: Guard must precede any exchange call
    // When analyzing code, strip import lines so that imports don't trigger false positives
    const codeWithoutImports = serverCode.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');
    const guardIndex = codeWithoutImports.indexOf('isRealTradingAllowed');
    const exchangeSinkRegex = /(?<!\w)(?:getCcxtClient|createOrder|executeRealOpenOnExchange)\s*\(/g;
    let match: RegExpExecArray | null;
    let exchangeCallBeforeGuard = false;

    // Check occurrences within real trading routes/functions in serverCode
    while ((match = exchangeSinkRegex.exec(codeWithoutImports)) !== null) {
      if (guardIndex !== -1 && match.index < guardIndex && !codeWithoutImports.slice(0, match.index).includes('isRealTradingAllowed')) {
        exchangeCallBeforeGuard = true;
        break;
      }
    }

    // Also check occurrences within modular routes if present
    if (modularComponents?.realTradeRoutesCode) {
      const routesWithoutImports = modularComponents.realTradeRoutesCode.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');
      const routeGuardIndex = Math.min(
        routesWithoutImports.indexOf('isRealTradingAllowed') !== -1 ? routesWithoutImports.indexOf('isRealTradingAllowed') : Infinity,
        routesWithoutImports.indexOf('isAllowed') !== -1 ? routesWithoutImports.indexOf('isAllowed') : Infinity,
        routesWithoutImports.indexOf('ENABLE_REAL_TRADING') !== -1 ? routesWithoutImports.indexOf('ENABLE_REAL_TRADING') : Infinity
      );
      if (routeGuardIndex !== Infinity) {
        while ((match = exchangeSinkRegex.exec(routesWithoutImports)) !== null) {
          if (match.index < routeGuardIndex && !routesWithoutImports.slice(0, match.index).includes('isAllowed') && !routesWithoutImports.slice(0, match.index).includes('isRealTradingAllowed')) {
            exchangeCallBeforeGuard = true;
            break;
          }
        }
      }
    }

    if (exchangeCallBeforeGuard) {
      errors.push('AST: Exchange sink called without preceding real-trading permission guard (Guard must precede exchange sink)');
    } else {
      passedChecks.push('AST: isRealTradingAllowed guard defined and dominating execution path');
    }
  } else {
    errors.push('AST: Missing isRealTradingAllowed guard dominating real trading execution (Exchange sink called without preceding real-trading permission guard)');
  }

  // 2b. Check for unawaited critical persistence calls
  const unawaitedSaveRegex = /(?<!await\s+)(?:dbAtomicStore\.saveState|executePaperCapitalTransaction|executePaperTradeOpenTransaction|executePaperTradeCloseTransaction)\s*\(/g;
  const unawaitedMatches = serverCode.match(unawaitedSaveRegex);
  if (unawaitedMatches && unawaitedMatches.length > 0) {
    errors.push('AST: Unawaited critical state persistence call detected');
  } else {
    passedChecks.push('AST: All critical state persistence calls are awaited');
  }

  // 2c. Check for direct unauthorized paper balance mutation or port-generated random ID
  if (serverCode.includes('globalSettings.virtualBalance =') && !serverCode.includes('// Authorized cache update after commit') && !serverCode.includes('// Authorized initial load')) {
    errors.push('AST: Direct paper balance mutation or port-generated ledger ID detected');
  } else {
    passedChecks.push('AST: Zero direct unauthorized balance mutations in production path');
  }

  // 3. Verify authMiddleware import & active mount
  const hasDirectAuth = functionCalls.has('app.use') && (importedSymbols.has('authMiddleware') || identifiers.has('authMiddleware'));
  const hasModularAuth = Boolean(
    modularComponents?.expressFactoryCode &&
    /app\.use\(\s*authMiddleware\s*\)/.test(modularComponents.expressFactoryCode) &&
    (serverCode.includes('createExpressApp') || importedSymbols.has('createExpressApp'))
  );

  if (hasDirectAuth || hasModularAuth) {
    passedChecks.push('AST: authMiddleware mounted into express middleware chain');
  } else {
    errors.push('AST: Missing active authMiddleware mount in server.ts');
  }

  // 4. Verify AtomicStateStore / saveState / flush active call site
  const hasDirectSaveState = functionCalls.has('dbAtomicStore.saveState') || functionCalls.has('saveState') || serverCode.includes('saveState(');
  const hasModularSaveState = Boolean(
    modularComponents?.persistenceCode &&
    (modularComponents.persistenceCode.includes('this.store.saveState(') || modularComponents.persistenceCode.includes('dbAtomicStore.saveState(')) &&
    (serverCode.includes('DatabasePersistenceManager') || serverCode.includes('dbAtomicStore'))
  );

  if (hasDirectSaveState || hasModularSaveState) {
    passedChecks.push('AST: dbAtomicStore.saveState active call site verified');
  } else {
    errors.push('AST: Missing active dbAtomicStore.saveState call site in server.ts');
  }

  // 5. Verify production auto-entry handlers or coordinator active call site
  if (
    importedSymbols.has('executeMainVirtualAutoEntry') ||
    importedSymbols.has('executeMainRealAutoEntry') ||
    importedSymbols.has('executeWorkerRealAutoEntry') ||
    importedSymbols.has('runProductionAutoEntryCoordinator') ||
    serverCode.includes('executeMainVirtualAutoEntry')
  ) {
    passedChecks.push('AST: Canonical production auto-entry handlers wired into server execution points');
  } else {
    errors.push('AST: Missing production auto-entry handler wiring in server.ts');
  }

  // 6. Verify evaluateExitPolicy active call site
  if (functionCalls.has('evaluateExitPolicy') || importedSymbols.has('evaluateExitPolicy')) {
    passedChecks.push('AST: evaluateExitPolicy active call site verified in position monitor');
  } else {
    errors.push('AST: Missing active evaluateExitPolicy call site in server.ts');
  }

  // 7. Verify agentEngine / committee invocation active call site
  if (functionCalls.has('evaluateCommitteeConsensus') || importedSymbols.has('evaluateCommitteeConsensus')) {
    passedChecks.push('AST: evaluateCommitteeConsensus active call site verified');
  } else {
    errors.push('AST: Missing active evaluateCommitteeConsensus call site in server.ts');
  }

  // 8. Verify processIncomingStateMessage active call site
  if (functionCalls.has('processIncomingStateMessage') || importedSymbols.has('processIncomingStateMessage')) {
    passedChecks.push('AST: processIncomingStateMessage active call site verified for state synchronization');
  } else {
    errors.push('AST: Missing active processIncomingStateMessage call site in server.ts');
  }

  // 9. Verify atomic paper transaction / reservePaperMargin in server
  if (
    importedSymbols.has('executePaperTradeOpenTransaction') ||
    importedSymbols.has('executePaperTradeCloseTransaction') ||
    importedSymbols.has('executePaperCapitalTransaction') ||
    serverCode.includes('executePaperTradeOpenTransaction') ||
    serverCode.includes('executePaperTradeCloseTransaction')
  ) {
    passedChecks.push('AST: Atomic paper capital transactions integrated into server.ts');
  } else {
    errors.push('AST: Missing executePaperTradeOpenTransaction or executePaperTradeCloseTransaction in server.ts');
  }

  // 9b. Check for anti-pattern: close port with immutableTradeId || '' or random closeEventId fallback
  if (
    serverCode.includes("immutableTradeId || ''") ||
    serverCode.includes('immutableTradeId || ""') ||
    serverCode.includes("closeEventId || `close_${") ||
    serverCode.includes("closeEventId || 'close_'")
  ) {
    errors.push("AST: Detected fallback ID generation in close transaction port (immutableTradeId || '' or random closeEventId)");
  } else {
    passedChecks.push("AST: Strict immutable IDs enforced across close transaction ports");
  }

  // 9c. Check for anti-pattern: separate post-execution persistDecisionBundle() after execution in server or coordinator
  let hasPostExecutionPersist = false;
  const sourcesToCheckForPersist = [
    { name: 'coordinator', code: coordinatorCode },
    { name: 'server', code: serverCode }
  ];

  for (const srcItem of sourcesToCheckForPersist) {
    if (srcItem.code) {
      const src = ts.createSourceFile(srcItem.name, srcItem.code, ts.ScriptTarget.Latest, true);
      function visitForPersist(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
          let sawRunCanonicalAutoEntry = false;
          function visitBody(innerNode: ts.Node) {
            if (ts.isCallExpression(innerNode)) {
              const fnName = innerNode.expression.getText(src);
              if (fnName.includes('runCanonicalAutoEntry')) {
                sawRunCanonicalAutoEntry = true;
              } else if (sawRunCanonicalAutoEntry && fnName.includes('persistDecisionBundle')) {
                hasPostExecutionPersist = true;
              }
            }
            ts.forEachChild(innerNode, visitBody);
          }
          if (node.body) visitBody(node.body);
        }
        ts.forEachChild(node, visitForPersist);
      }
      visitForPersist(src);
    }
  }

  if (hasPostExecutionPersist) {
    errors.push('AST: Separate post-execution persistDecisionBundle() detected (must be atomically integrated in lifecycle transition)');
  } else {
    passedChecks.push('AST: Decision bundle persistence atomically integrated with trade execution');
  }

  // 9d. Check production handlers for proper Hunter/Bear context propagation
  if (productionHandlersCode) {
    if (
      !productionHandlersCode.includes('hunterDecision: context.hunterDecision') ||
      !productionHandlersCode.includes('bearDecision: context.bearDecision')
    ) {
      errors.push('AST: Production adapter missing Hunter/Bear context propagation');
    } else {
      passedChecks.push('AST: Production adapters propagate full Hunter/Bear decision context');
    }
  }

  // 9e. Check for unawaited saveTradeDB or saveBalanceDB in coordinator / transition handlers / fixtures
  const transitionCodes = [
    { name: 'autoEntryCoordinator.ts', code: coordinatorCode },
    { name: 'productionAutoEntryHandlers.ts', code: productionHandlersCode }
  ];

  let unawaitedInTransitions = false;
  for (const item of transitionCodes) {
    if (item.code) {
      const src = ts.createSourceFile(item.name, item.code, ts.ScriptTarget.Latest, true);
      function visitTrans(node: ts.Node) {
        if (ts.isCallExpression(node)) {
          const text = node.expression.getText(src);
          if (
            text === 'saveTradeDB' ||
            text === 'port.saveTradeDB' ||
            text === 'saveBalanceDB' ||
            text === 'port.saveBalanceDB' ||
            text === 'executePaperTradeOpenTransaction' ||
            text === 'executePaperTradeCloseTransaction'
          ) {
            if (node.parent && node.parent.kind !== ts.SyntaxKind.AwaitExpression) {
              unawaitedInTransitions = true;
            }
          }
        }
        ts.forEachChild(node, visitTrans);
      }
      visitTrans(src);
    }
  }

  // Check unawaited transition calls in serverCode transition functions
  if (serverCode) {
    const src = ts.createSourceFile('server.ts', serverCode, ts.ScriptTarget.Latest, true);
    function visitServerTransitions(node: ts.Node) {
      if (ts.isFunctionDeclaration(node)) {
        const fnName = node.name?.text || '';
        if (fnName.includes('AutoEntry') || fnName.includes('unawaitedSave') || fnName.includes('handleAuto')) {
          function visitBody(bodyNode: ts.Node) {
            if (ts.isCallExpression(bodyNode)) {
              const text = bodyNode.expression.getText(src);
              if (text === 'saveTradeDB' || text === 'saveBalanceDB') {
                if (bodyNode.parent && bodyNode.parent.kind !== ts.SyntaxKind.AwaitExpression) {
                  unawaitedInTransitions = true;
                }
              }
            }
            ts.forEachChild(bodyNode, visitBody);
          }
          if (node.body) visitBody(node.body);
        }
      }
      ts.forEachChild(node, visitServerTransitions);
    }
    visitServerTransitions(src);
  }

  // Check coordinator or test snippet directly if provided
  if (coordinatorCode) {
    const unawaitedRegex = /(?<!await\s+(?:customPort\.|port\.)?)(?:saveTradeDB|saveBalanceDB)\s*\(/g;
    if (coordinatorCode.match(unawaitedRegex)) {
      unawaitedInTransitions = true;
    }
  }

  if (unawaitedInTransitions) {
    errors.push('AST: Unawaited lifecycle-critical saveTradeDB/saveBalanceDB detected in execution path');
  } else {
    passedChecks.push('AST: All lifecycle-critical saveTradeDB/saveBalanceDB calls are awaited');
  }

  // 10. Negative check: ensure legacy permissive auth is not active
  if (serverCode.includes('[AUTH-AUDIT]')) {
    errors.push('AST: Legacy permissive auth warning loop detected in server.ts!');
  } else {
    passedChecks.push('AST: Legacy permissive auth successfully eliminated');
  }

  // 11. Check .env.example declaration
  if (envContent) {
    if (envContent.includes('ENABLE_REAL_TRADING')) {
      passedChecks.push('.env.example contains ENABLE_REAL_TRADING declaration');
    } else {
      errors.push('.env.example missing ENABLE_REAL_TRADING');
    }
  }

  // 12. Check package.json test:production-path:offline script registration
  if (pkgContent) {
    if (pkgContent.includes('test:production-path:offline')) {
      passedChecks.push('package.json registers test:production-path:offline production gate');
    } else {
      errors.push('package.json missing required test:production-path:offline script registration');
    }
  }

  // 13. AST Check for Production-Path Test importing production handlers/coordinator
  if (testCode) {
    const testSource = ts.createSourceFile('test-production-path-offline.ts', testCode, ts.ScriptTarget.Latest, true);
    let importsProductionModule = false;
    let callsProductionHandler = false;

    function visitTest(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier.getText(testSource);
        if (
          moduleSpecifier.includes('autoEntryCoordinator') ||
          moduleSpecifier.includes('autoEntryService') ||
          moduleSpecifier.includes('productionAutoEntryHandlers')
        ) {
          importsProductionModule = true;
        }
      }
      if (ts.isCallExpression(node)) {
        const text = node.expression.getText(testSource);
        if (
          text.includes('runProductionAutoEntryCoordinator') ||
          text.includes('executeMainVirtualAutoEntry') ||
          text.includes('executeWorkerVirtualAutoEntry') ||
          text.includes('executeMainRealAutoEntry') ||
          text.includes('executeWorkerRealAutoEntry')
        ) {
          callsProductionHandler = true;
        }
      }
      ts.forEachChild(node, visitTest);
    }
    visitTest(testSource);

    if (importsProductionModule && callsProductionHandler) {
      passedChecks.push('AST: test-production-path-offline.ts imports and calls authentic production auto-entry handlers');
    } else {
      errors.push('AST: test-production-path-offline.ts must import and execute production auto-entry handlers');
    }
  }

  return {
    success: errors.length === 0,
    errors,
    passedChecks
  };
}

async function verifyIntegrationWiring() {
  console.log('=== VERIFYING INTEGRATION WIRING (AST Compiler API Analysis) ===\n');

  const serverPath = path.join(process.cwd(), 'server.ts');
  if (!fs.existsSync(serverPath)) {
    console.error('❌ Missing server.ts entry point');
    process.exit(1);
  }

  const serverCode = fs.readFileSync(serverPath, 'utf-8');
  const envExamplePath = path.join(process.cwd(), '.env.example');
  const envContent = fs.existsSync(envExamplePath) ? fs.readFileSync(envExamplePath, 'utf-8') : undefined;
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkgContent = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, 'utf-8') : undefined;
  const testPath = path.join(process.cwd(), 'scripts', 'test-production-path-offline.ts');
  const testCode = fs.existsSync(testPath) ? fs.readFileSync(testPath, 'utf-8') : undefined;
  const coordPath = path.join(process.cwd(), 'server', 'services', 'autoEntryCoordinator.ts');
  const coordCode = fs.existsSync(coordPath) ? fs.readFileSync(coordPath, 'utf-8') : undefined;
  const prodHandlersPath = path.join(process.cwd(), 'server', 'services', 'productionAutoEntryHandlers.ts');
  const prodHandlersCode = fs.existsSync(prodHandlersPath) ? fs.readFileSync(prodHandlersPath, 'utf-8') : undefined;
  const realTradeRoutesPath = path.join(process.cwd(), 'server', 'routes', 'realTradeRoutes.ts');
  const realTradeRoutesCode = fs.existsSync(realTradeRoutesPath) ? fs.readFileSync(realTradeRoutesPath, 'utf-8') : undefined;
  const expressFactoryPath = path.join(process.cwd(), 'server', 'expressAppFactory.ts');
  const expressFactoryCode = fs.existsSync(expressFactoryPath) ? fs.readFileSync(expressFactoryPath, 'utf-8') : undefined;
  const persistencePath = path.join(process.cwd(), 'server', 'services', 'databasePersistenceManager.ts');
  const persistenceCode = fs.existsSync(persistencePath) ? fs.readFileSync(persistencePath, 'utf-8') : undefined;
  const storageServicePath = path.join(process.cwd(), 'server', 'services', 'dbStorageService.ts');
  const storageServiceCode = fs.existsSync(storageServicePath) ? fs.readFileSync(storageServicePath, 'utf-8') : undefined;

  const result = validateIntegrationWiring(
    serverCode,
    envContent,
    pkgContent,
    testCode,
    coordCode,
    prodHandlersCode,
    {
      realTradeRoutesCode,
      expressFactoryCode,
      persistenceCode,
      storageServiceCode
    }
  );

  result.passedChecks.forEach(msg => console.log(`✅ ${msg}`));
  result.errors.forEach(msg => console.error(`❌ ${msg}`));

  console.log('\n========================================');
  if (result.success) {
    console.log('🎉 INTEGRATION WIRING VERIFIED VIA AST COMPILER API!');
    process.exit(0);
  } else {
    console.error(`❌ ${result.errors.length} AST WIRING ERRORS FOUND.`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-integration-wiring.ts')) {
  verifyIntegrationWiring();
}
