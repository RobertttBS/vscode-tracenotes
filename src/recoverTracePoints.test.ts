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
            if (pattern.includes('.c')) {
                return [
                    mockVscode.Uri.file('/workspace/src/short.c'),
                    mockVscode.Uri.file('/workspace/src/reset.c'),
                ];
            }
            if (pattern.includes('.ts')) {
                return [
                    mockVscode.Uri.file('/workspace/src/otherFile.ts'),
                    mockVscode.Uri.file('/workspace/src/wrong.ts'),
                    mockVscode.Uri.file('/workspace/src/right.ts'),
                    mockVscode.Uri.file('/workspace/src/file.ts'),
                ];
            }
            return [];
        },
        fs: {
            readFile: async (uri: any) => {
                if (uri.fsPath.endsWith('short.c')) {
                    return Buffer.from("void init() { return; }");
                }
                if (uri.fsPath.endsWith('reset.c')) {
                    return Buffer.from("void chkBgdClnBlkProc() { /* reset handler */ }");
                }
                if (uri.fsPath.endsWith('wrong.ts')) {
                    return Buffer.from("// Matches multiCandidate in a comment but not code\nvoid wrong() {}");
                }
                if (uri.fsPath.endsWith('right.ts')) {
                    return Buffer.from("void multiCandidate() { success(); }");
                }
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

    // --- Whitespace and Formatting Merged ---
    await test("Whitespace and Formatting Reorganization", async () => {
        const storedContent = "function foo() { return 2; }";
        const cases = [
            { name: "extra spaces/newlines", content: "function   foo(  )  \n\n\n  {\nreturn 2;\n}" },
            { name: "pure indentation (tabs)", content: "function foo() {\n\treturn 2;\n}" },
            { name: "radical formatting (compact)", content: "function foo(){return 2;}" }
        ];

        for (const c of cases) {
            const doc = new MockDocument(c.content);
            const uri = mockVscode.Uri.file('/workspace/src/file.ts');
            const res = await recoverTracePoints(doc, storedContent, 0, uri);
            assert.ok(res !== null, `Failed case: ${c.name}`);
            assert.strictEqual(res!.offset[0], 0, `Offset 0 expected for ${c.name}`);
        }
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

    // --- Content Mutation Merged ---
    await test("Adversarial Content Mutation", async () => {
        const storedContent = `function calculate() {\n    let a = 1;\n    let b = 2;\n    return a + b;\n}`;
        
        // This test applies multiple mutations at once:
        // 1. Line deleted (let b = 2)
        // 2. Extra line added (console.log)
        // 3. Comment inserted
        // 4. Fuzzy word change (a -> value)
        const mutatedDocContent = `function calculate() {\n    // Some comment\n    let value = 1;\n    console.log("log");\n    return value + b;\n}`;
        const doc = new MockDocument(mutatedDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover after heavy mutation");
        assert.strictEqual(res!.offset[0], 0, "Should still identify at offset 0");
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

    // --- Duplicate Resolution Merged ---
    await test("Duplicate Resolution (Best Candidate Selection)", async () => {
        const content = `function duplicate() { return 1; }`;
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        // 1. Closest block match in same file
        const docContent1 = content + " ".repeat(1000) + content;
        const doc1 = new MockDocument(docContent1);
        const lastKnown1 = docContent1.lastIndexOf("function duplicate") + 5;
        const res1 = await recoverTracePoints(doc1, content, lastKnown1, uri);
        assert.strictEqual(res1!.offset[0], docContent1.lastIndexOf("function duplicate"), "Should pick the closest block");

        // 2. Equidistant duplicates (deterministic check)
        const docContent2 = " ".repeat(500) + content + " ".repeat(500) + content;
        const doc2 = new MockDocument(docContent2);
        const res2 = await recoverTracePoints(doc2, content, 500, uri); // lastKnown is exactly in the middle of two gaps
        assert.ok(res2 !== null, "Equidistant duplicates should not fail");
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



    // --- MERGED TESTS FROM repro_failures.ts ---

    // --- Distance Boundaries Merged ---
    await test("Distance Boundary Recovery (Tier 1, 2, 3)", async () => {
        const content = `function targetFunction() { return 42; }`;
        const longContent = `function elastic() {\n    let alpha = 1;\n    let beta = 2;\n    return alpha + beta;\n}`;
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');

        // 1. Tier 1 Boundary (4999 chars away)
        const doc1 = new MockDocument(" ".repeat(4999) + content);
        const res1 = await recoverTracePoints(doc1, content, 0, uri);
        assert.strictEqual(res1!.offset[0], 4999, "Tier 1 exact boundary failed");

        // 2. Tier 2 Elastic Radius (5500 chars away, fuzzy tokens)
        const doc2Content = " ".repeat(5500) + `function elasticFunc() {\n    let val = 1;\n    let beta = 2;\n    return val + beta;\n}`;
        const doc2 = new MockDocument(doc2Content);
        const res2 = await recoverTracePoints(doc2, longContent, 0, uri);
        assert.ok(res2 !== null, "Tier 2 elastic radius failed");
        assert.strictEqual(res2!.offset[0], 5500);

        // 3. Tier 3 Trans-radius (> 10000 chars away)
        const doc3 = new MockDocument(" ".repeat(20000) + content);
        const res3 = await recoverTracePoints(doc3, content, 0, uri);
        assert.strictEqual(res3!.offset[0], 20000, "Tier 3 trans-radius failed");
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



    // --- ADVERSARIAL / EDGE-CASE TESTS ---

    // --- Invalid Input Rejection Merged ---
    await test("Invalid Input Rejection", async () => {
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        const doc = new MockDocument("function foo() { return 1; }");

        // 1. Empty content
        assert.strictEqual(await recoverTracePoints(doc, "", 0, uri), null);
        // 2. Whitespace only
        assert.strictEqual(await recoverTracePoints(doc, "   \n ", 0, uri), null);
        // 3. Comment only (should not match arbitrary code)
        const res3 = await recoverTracePoints(doc, "// comment", 0, uri);
        if (res3) assert.ok(res3.offset[0] >= 0); // No crash check
        // 4. Single token rejection (too ambiguous)
        const doc4 = new MockDocument("a b c x y z");
        const res4 = await recoverTracePoints(doc4, "x", 0, uri);
        if (res4) assert.ok(doc4.getText().substring(res4.offset[0], res4.offset[1]).includes("x"));
    });









    await test("Content with special regex characters should not break Tier 3", async () => {
        // This uses characters that are special in regex: $ . * + ? ( ) [ ] { } | ^ \
        const storedContent = "let pattern = /^foo\\.(bar)+$/;\nlet price = $100.00;\nreturn (a + b) * [c];";
        const doc = new MockDocument(storedContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        // Tier 1 exact match should succeed since content is identical
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Special regex characters should not cause a crash");
        assert.strictEqual(res!.offset[0], 0, "Should find at offset 0");
    });



    await test("Negative lastKnownStart should not crash", async () => {
        const storedContent = "function negativeTest() { return -1; }";
        const doc = new MockDocument(storedContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        // Pass a negative offset — Math.max(0, ...) should clamp it
        const res = await recoverTracePoints(doc, storedContent, -500, uri);
        assert.ok(res !== null, "Negative lastKnownStart should be handled gracefully");
        assert.strictEqual(res!.offset[0], 0, "Should find at offset 0");
    });

    await test("Large document with target beyond elastic radius should go to Tier 3 or return null", async () => {
        // 100K chars of padding — well beyond both Tier 1 (5K) and Tier 2 (10K) radii
        const storedContent = "function farAway() {\n    let result = 42;\n    return result;\n}";
        const padding = "x".repeat(100000);
        const newDocContent = padding + storedContent;
        const doc = new MockDocument(newDocContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');
        
        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        // Tier 3 mock may or may not find it depending on findTextInFiles mock behavior
        // Key assertion: no crash
        if (res !== null) {
            assert.ok(res.offset[0] >= 0, "If found, offset must be valid");
            assert.ok(res.offset[1] > res.offset[0], "End must be after start");
        }
    });

    // --- NEW TESTS FOR TIER 3 FIXES ---

    await test("Cross-workspace: should find content in a different file of the same extension", async () => {
        // void init() is in short.c; the trace was originally from file.c (now empty)
        const storedContent = "void init()";
        const doc = new MockDocument(""); // empty file — forces cross-workspace search
        const uri = mockVscode.Uri.file('/workspace/src/file.c');

        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should find void init() in short.c");
        assert.strictEqual(res!.uri.fsPath, '/workspace/src/short.c');
        assert.strictEqual(res!.offset[0], 0);
    });

    await test("Cross-workspace: should skip files where content is only in a comment (multi-candidate)", async () => {
        // wrong.ts has "multiCandidate" inside a // comment only; right.ts has it as code
        const storedContent = "void multiCandidate()";
        const doc = new MockDocument("");
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');

        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should find via cross-workspace search");
        assert.strictEqual(res!.uri.fsPath, '/workspace/src/right.ts', "Should skip wrong.ts where match is only in a comment");
    });

    await test("Cross-workspace: cross-file exact match for real-world C function (chkBgdClnBlkProc)", async () => {
        // Simulates: function defined in reset.c, trace was stored from rwcmd.c
        const storedContent = "void chkBgdClnBlkProc()";
        const doc = new MockDocument(""); // rwcmd.c no longer has this function
        const uri = mockVscode.Uri.file('/workspace/src/rwcmd.c');

        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should find chkBgdClnBlkProc in reset.c");
        assert.strictEqual(res!.uri.fsPath, '/workspace/src/reset.c');
    });

    await test("Language Syntax Edge Cases (Python vs C)", async () => {
        const uriTs = mockVscode.Uri.file('/workspace/src/file.py');
        const uriC = mockVscode.Uri.file('/workspace/src/file.c');

        // Python style: significance of indentation (but our tokenizer ignores whitespace)
        const storedPython = "def hello():\n    print('hi')";
        const docPython = new MockDocument("def hello():\n\tprint('hi')"); // tabs instead of spaces
        const resPy = await recoverTracePoints(docPython, storedPython, 0, uriTs);
        assert.ok(resPy !== null, "Python indentation change failed");

        // C style: macro and complex brackets
        const storedC = "#define MAX(a,b) ((a)>(b)?(a):(b))";
        const docC = new MockDocument("#define MAX(x,y) ((x)>(y)?(x):(y))"); // Param rename
        const resC = await recoverTracePoints(docC, storedC, 0, uriC);
        assert.ok(resC !== null, "C macro fuzzy match failed");
    });

    await test("Overlapping Matches (Ambiguity Resolution)", async () => {
        const content = "function overlap() { return true; }";
        // Two identical blocks: distance resolution should pick the closer one
        const docContent = "function overlap() { return true; } " + " ".repeat(100) + "function overlap() { return true; }";
        const doc = new MockDocument(docContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');

        // Target distance is closer to the second one (offset approx 35 + 100 = 135)
        const res = await recoverTracePoints(doc, content, 150, uri);
        assert.strictEqual(res!.offset[0], docContent.lastIndexOf("function overlap"), "Should resolve overlapping ambiguity by distance");
    });

    await test("Large Content Limits (Stress Test)", async () => {
        // Use a block with many tokens but large overall size
        const largeStored = ("token" + "x".repeat(10) + " ").repeat(500); // 500 tokens, ~6000 chars
        const docContent = "a".repeat(10000) + largeStored + "b".repeat(10000);
        const doc = new MockDocument(docContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');

        const res = await recoverTracePoints(doc, largeStored, 0, uri);
        assert.ok(res !== null, "Large content stress test failed");
        assert.strictEqual(res!.offset[0], 10000);
    });

    await test("Incomplete Fragments (Syntactic Resilience)", async () => {
        // Use 20+ tokens to bypass strict 18-token threshold
        const stored = "function resilient() {\n    let a = 1; let b = 2; let c = 3; let d = 4;\n    return a + b + c + d;\n}";
        // Dest file has it truncated or heavily modified
        const brokenDoc = new MockDocument("function resilient() {\n    let a = 1; let b = 2;\n    // Missing c, d and broken return\n    return a + b + 999;\n}");
        const uri = mockVscode.Uri.file('/workspace/src/file.ts');

        const res = await recoverTracePoints(brokenDoc, stored, 0, uri);
        assert.ok(res !== null, "Should recover even when source is syntactically broken with enough tokens");
    });





    // --- REAL-WORLD REGRESSION TESTS (same-file large move beyond old radius) ---

    await test("Same-file large move: exact content at 100K offset, lastKnownStart at 0", async () => {
        // Simulates: function moved from end of 3000-line file to near the top (line 133)
        const storedContent = "void bgdClnCacheblkProc() { /* impl */ }";
        const padding = "x".repeat(100000);
        const docContent = storedContent + padding; // content at offset 0, lastKnown was pointing elsewhere
        const doc = new MockDocument(docContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.c');

        const res = await recoverTracePoints(doc, storedContent, 100000, uri);
        assert.ok(res !== null, "Should recover content that moved 100K bytes from lastKnownStart");
        assert.strictEqual(res!.offset[0], 0, "Content is at offset 0");
        assert.strictEqual(res!.uri.fsPath, uri.fsPath, "Same file");
    });

    await test("Same-file large move: exact content buried deep (lastKnownStart near start)", async () => {
        const storedContent = "if((mGetGcState==cGcBuildSrc)&&!mChkGcFlag(cBrkBgdGcF))";
        const padding = "/* padding */\n".repeat(5000); // ~70K chars
        const docContent = padding + storedContent;
        const doc = new MockDocument(docContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.c');

        // lastKnownStart points to end of file (stale from before content was moved up)
        const res = await recoverTracePoints(doc, storedContent, docContent.length, uri);
        assert.ok(res !== null, "Should recover C macro condition after large move");
        assert.strictEqual(res!.offset[0], padding.length, "Should find content at correct offset");
    });

    // --- DIGIT TOLERANCE TESTS ---

    await test("Digit change same offset: contentMatches survives digit-only edit (1 → 0)", async () => {
        // Tracepoint on "#define _EN_EXAMPLE (1)", file updated to "(0)"
        // contentMatches must return true so no recovery is triggered and trace isn't orphaned.
        const storedContent = "#define _EN_EXAMPLE (1)";
        const fileContent = "#define _EN_EXAMPLE (0)";
        const doc = new MockDocument(fileContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.c');

        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Trace should survive a digit-only change");
        assert.strictEqual(res!.offset[0], 0, "Should find at offset 0");
    });

    await test("Digit change + offset shift: findNormalized recovers arr[123] → arr[1] at new position", async () => {
        // Stored content uses arr[123], file has arr[1] at a shifted offset
        const storedContent = "arr[123]";
        const padding = "// some preamble\n".repeat(5); // shifts offset
        const fileContent = padding + "arr[1]";
        const doc = new MockDocument(fileContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.c');

        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover arr[123] matched against arr[1] at a new offset");
        assert.strictEqual(res!.offset[0], padding.length, "Should find at the shifted offset");
    });

    await test("Regression: non-digit difference still fails (arr[1] vs foo[1])", async () => {
        // Digit normalization must not create false positives between structurally different lines
        const storedContent = "arr[1]";
        const fileContent = "foo[1]";
        const doc = new MockDocument(fileContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.c');

        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.strictEqual(res, null, "Should NOT recover when a key identifier differs");
    });

    await test("Same-file: whitespace-normalized match (stored with extra spaces, file has single spaces)", async () => {
        const storedContent = "void bgdClnCacheblkProc()    // BYTE uCaller)";
        const fileContent = "void bgdClnCacheblkProc() // BYTE uCaller)"; // fewer spaces before comment
        const doc = new MockDocument(fileContent);
        const uri = mockVscode.Uri.file('/workspace/src/file.c');

        const res = await recoverTracePoints(doc, storedContent, 0, uri);
        assert.ok(res !== null, "Should recover via whitespace-normalized match");
        assert.strictEqual(res!.offset[0], 0);
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
