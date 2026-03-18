import * as assert from 'assert';
import * as path from 'path';

// --- MOCK VSCODE ---
const mockVscode = {
    Uri: {
        file: (pathStr: string) => ({ fsPath: pathStr, toString: () => pathStr }),
        joinPath: (base: any, ...segments: string[]) => ({ fsPath: path.join(base.fsPath, ...segments), toString: () => path.join(base.fsPath, ...segments) }),
        parse: (pathStr: string) => mockVscode.Uri.file(pathStr)
    },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        findFiles: async (pattern: string) => {
            if (pattern.includes('.ts')) {
                return [mockVscode.Uri.file('/workspace/src/otherFile.ts')];
            }
            return [];
        },
        findTextInFiles: async (query: any, options: any, callback: any, token: any) => {
            // Tier 3 Phase 1: Robust Native Match Search
            if (query.pattern.includes('testFunc') || query.pattern.includes('targetFunction') || query.pattern.includes('calculateTotal')) {
                callback({ uri: mockVscode.Uri.file('/workspace/src/otherFile.ts') });
                // Also return the original file to test same-file Tier 3 recovery
                callback({ uri: mockVscode.Uri.file('/workspace/src/file.ts') });
            }
            // Case-insensitive check for Tier 3 Phase 1 fix
            if (query.pattern.includes('calculatetotal')) {
                callback({ uri: mockVscode.Uri.file('/workspace/src/otherFile.ts') });
            }
            // Phase 2: Anchor Words
            if (query.pattern.includes('|')) {
                callback({ uri: mockVscode.Uri.file('/workspace/src/otherFile.ts') });
                callback({ uri: mockVscode.Uri.file('/workspace/src/file.ts') });
            }
            return { limitHit: false };
        },
        fs: {
            readFile: async (uri: any) => {
                if (uri.fsPath.endsWith('otherFile.ts')) {
                    const content = `
// Some other file
function testFunc() {
    console.log("hello");
}
function calculatetotal() { return 0; }
`;
                    return Buffer.from(content);
                }
                if (uri.fsPath.endsWith('file.ts')) {
                    // This mock needs to be dynamic for some tests, but we'll provide a default
                    // that matches the "targetFunction" test case.
                    return Buffer.from(" ".repeat(20000) + "function targetFunction() { return 42; }");
                }
                return new Uint8Array();
            },
            createDirectory: async () => {},
            writeFile: async () => {}
        },
        getConfiguration: () => ({ get: () => 'utf8' }),
        textDocuments: [],
        onDidCloseTextDocument: () => ({ dispose: () => {} }),
        onDidChangeTextDocument: () => ({ dispose: () => {} })
    },
    Range: class Range { constructor(public start: any, public end: any) {} },
    Position: class Position { constructor(public line: number, public character: number) {} },
    EventEmitter: class EventEmitter { fire() {} event = () => {} },
    window: {
        createOutputChannel: () => ({ 
            appendLine: () => {},
            warn: () => {},
            error: () => {},
            info: () => {}
        }),
        showErrorMessage: () => {}
    },
    CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() {}; dispose() {} }
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(request: string) {
    if (request === 'vscode') {
        return mockVscode;
    }
    return originalRequire.apply(this, arguments);
};

// --- IMPORT TRACEMANAGER ---
import { TraceManager } from './traceManager';

// Mock ITraceDocument
class MockDocument {
    constructor(private text: string) {}
    getText(range?: any) {
        if (!range) return this.text;
        const start = this.offsetAt(range.start);
        const end = this.offsetAt(range.end);
        return this.text.substring(start, end);
    }
    positionAt(offset: number) {
        let line = 0;
        let char = 0;
        for (let i = 0; i < offset; i++) {
            if (this.text[i] === '\n') {
                line++;
                char = 0;
            } else {
                char++;
            }
        }
        return new mockVscode.Position(line, char);
    }
    offsetAt(position: any) {
        const lines = this.text.split('\n');
        let offset = 0;
        for (let i = 0; i < position.line; i++) {
            offset += lines[i].length + 1; // +1 for \n
        }
        return offset + position.character;
    }
    get lineCount() {
        return this.text.split('\n').length;
    }
    lineAt(line: number) {
        const lines = this.text.split('\n');
        const text = lines[line] || '';
        return { 
            text, 
            range: { end: new mockVscode.Position(line, text.length) } 
        };
    }
}

async function runTests() {
    console.log("Running recoverTracePoints tests...\n");

    const contextMock = {
        subscriptions: [],
        globalStorageUri: mockVscode.Uri.file('/tmp'),
        workspaceState: {
            get: () => ({}),
            update: async () => {}
        },
        globalState: {
            get: () => ({}),
            update: async () => {}
        }
    } as any;

    const manager = new TraceManager(contextMock);
    
    // We bind the private recoverTracePoints to the manager for testing
    const recoverTracePoints = (manager as any).recoverTracePoints.bind(manager);

    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            console.log(`✅ PASS: ${name}`);
            passed++;
        } catch (err: any) {
            console.error(`❌ FAIL: ${name}`);
            console.error(`   ${err.message}`);
            failed++;
        }
    }

    await test("Should recover cross file", async () => {
        const doc = new MockDocument(""); // File is empty
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        // Exact content match but formatted identical to otherFile.ts
        const storedContent = `function testFunc() {
    console.log("hello");
}`;
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should return a result");
        assert.strictEqual(res.uri.fsPath, '/workspace/src/otherFile.ts', "Should recover in otherFile.ts");
    });

    await test("Should ignore spaces and newlines", async () => {
        // Document has weird spacing
        const doc = new MockDocument("function   foo(  )  \n\n\n  {\nreturn 2;\n}");
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const storedContent = "function foo() { return 2; }";
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Failed to recover trace point with different whitespace");
        assert.strictEqual(res.uri.fsPath, uri.fsPath);
    });

    await test("Should treat '()' and '{}' as significant", async () => {
        // Document is missing brackets entirely
        const doc = new MockDocument("function foo   return 2;");
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const storedContent = "function foo() { return 2; }";
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.strictEqual(res, null, "Should NOT recover if brackets/braces are missing");
    });

    await test("Should recover when function is pasted elsewhere in the same file (moved down)", async () => {
        const storedContent = `function calculate() {\n    let a = 1;\n    let b = 2;\n    return a + b;\n}`;
        const newDocContent = "\n".repeat(50) + storedContent;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should return a result");
        assert.strictEqual(res!.uri.fsPath, uri.fsPath, "Should stay in the same file");
        assert.ok(res!.offset[0] > 0, "Start offset should be dynamically adjusted");
    });

    await test("Should recover when middle line is deleted", async () => {
        const storedContent = `function calculate() {\n    let a = 1;\n    let b = 2;\n    return a + b;\n}`;
        const newDocContent = `function calculate() {\n    let a = 1;\n    return a + b;\n}`;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover even when middle line is deleted");
        assert.strictEqual(res!.offset[0], 0, "Start offset should be 0");
        assert.ok(res!.offset[1] > 0, "End offset is set");
    });

    await test("Should recover when extra lines are added inside", async () => {
        const storedContent = `function calculate() {\n    let a = 1;\n    let b = 2;\n    return a + b;\n}`;
        const newDocContent = `function calculate() {\n    let a = 1;\n    console.log("added");\n    let b = 2;\n    return a + b;\n}`;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover when lines are added");
        assert.strictEqual(res!.offset[0], 0, "Start offset should be 0");
        assert.ok(res!.offset[1] > 0, "End offset is set");
    });

    await test("Should recover when comments are inserted (tokenizer ignores them)", async () => {
        const storedContent = `function calculate() {\n    let a = 1;\n    return a + b;\n}`;
        const newDocContent = `function calculate() {\n    // comment\n    let a = 1;\n    /* block */\n    return a + b;\n}`;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover ignoring comments");
        assert.strictEqual(res!.offset[0], 0, "Start offset should be 0");
    });

    await test("Should recover when words change (fuzzy match)", async () => {
        const storedContent = `function calculate() {\n    let a = 1;\n    let b = 2;\n    return a + b;\n}`;
        const newDocContent = `function calc() {\n    let x = 1;\n    let b = 2;\n    return x + b;\n}`;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover with fuzzy match");
        assert.strictEqual(res!.offset[0], 0, "Start offset should be 0");
    });

    await test("Should recover completely identical code moved up", async () => {
        const storedContent = `function calculate() {\n    let a = 1;\n    let b = 2;\n    return a + b;\n}`;
        const newDocContent = storedContent + "\n".repeat(50) + "// original location";
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        // original start was at line 50.
        const res = await recoverTracePoints(doc, storedContent, 1000, uri);
        assert.ok(res !== null, "Should return a result");
        assert.strictEqual(res!.offset[0], 0, "Start offset should dynamically adjust to 0");
    });

    await test("Should match the closest block when duplicates exist", async () => {
        const storedContent = `function calculate() {\n    return 42;\n}`;
        // Put one duplicate at start, one at end. Target is at offset 500.
        const newDocContent = storedContent + " ".repeat(1000) + storedContent;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        // Target is at 1000 + length
        const expectedStart = newDocContent.lastIndexOf("function calculate");
        const res = await recoverTracePoints(doc, storedContent, expectedStart + 10, uri);
        
        assert.ok(res !== null, "Should return a result");
        assert.strictEqual(res!.offset[0], expectedStart, "Start offset should match the closest identical block");
    });

    await test("Should recover when purely indentation is changed", async () => {
        const storedContent = `function calculate() {\n    let a = 1;\n    let b = 2;\n    return a + b;\n}`;
        const newDocContent = `function calculate() {\n\t\tlet a = 1;\n\t\tlet b = 2;\n\t\treturn a + b;\n}`; // using tabs
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover indentation changes");
    });

    await test("Short content should NOT match wrong identifier (int foo vs int test)", async () => {
        const storedContent = `int foo(void) {`;
        const newDocContent = `int test(void) {\n    return 0;\n}`;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.c');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.strictEqual(res, null, "Should NOT recover when a key identifier differs in short content");
    });

    await test("Short content SHOULD match when identical", async () => {
        const storedContent = `int foo(void) {`;
        const newDocContent = `// some header\nint foo(void) {\n    return 0;\n}\nint test(void)\n`;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.c');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover short content when it matches exactly");

        const expectedStart = newDocContent.indexOf(storedContent);
        const expectedEnd = expectedStart + storedContent.length;
        assert.strictEqual(res!.offset[0], expectedStart, "Should match the correct start offset");
        assert.strictEqual(res!.offset[1], expectedEnd, "Should match the correct end offset");
    });

    await test("Should not recover completely unrelated code", async () => {
        const storedContent = `function process() { let x = 1; let y = 2; return x + y; }`;
        const newDocContent = `function unrelated() { console.log('hello window'); return true; }`;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.strictEqual(res, null, "Should not recover completely unrelated code");
    });

    await test("Should recover when formatting is radically changed", async () => {
        const storedContent = `function calculate() {\n    let a = 1;\n    let b = 2;\n    return a + b;\n}`;
        const newDocContent = `function calculate(){let a=1;let b=2;return a+b;}`;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover formatting changes");
        assert.strictEqual(res!.offset[0], 0, "Start offset should be 0");
    });

    // --- MERGED TESTS FROM repro_failures.ts ---

    await test("Should recover when moved > 10,000 chars in same file (Trans-radius fix)", async () => {
        const content = `function targetFunction() { return 42; }`;
        const padding = " ".repeat(20000);
        const newDocContent = padding + content;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        // Stored position was 0, now it's 20000. 
        // This forces Tier 3 which now includes the same file.
        const res = await recoverTracePoints(doc, content, 0, uri);
        assert.ok(res !== null, "Should recover even if moved far away in same file");
        assert.strictEqual(res!.offset[0], 20000);
    });

    await test("Should recover cross-file if casing changed (Case-insensitive Tier 3 fix)", async () => {
        const storedContent = `function calculateTotal() {`;
        // otherFile.ts has "function calculatetotal() { return 0; }"
        const doc = new MockDocument(""); // Empty doc to force Tier 3
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover even if casing changed in workspace search");
        assert.strictEqual(res.uri.fsPath, '/workspace/src/otherFile.ts');
    });

    await test("Should pick the CLOSEST match in Tier 2 when duplicates exist (Sliding Window Fix)", async () => {
        const content = `function duplicate() { return 1; }`;
        const docContent = content + " ".repeat(500) + content;
        const doc = new MockDocument(docContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        // Target is closer to index 0
        const res = await recoverTracePoints(doc, content, 0, uri);
        assert.strictEqual(res!.offset[0], 0, "Should pick the first occurrence as it is closer to lastKnownStart (0)");
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Test suite threw an error:", err);
    process.exit(1);
});
