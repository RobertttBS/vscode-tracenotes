export type SearchNode =
    | { type: 'term'; value: string }
    | { type: 'phrase'; value: string }
    | { type: 'and'; children: SearchNode[] }
    | { type: 'or'; children: SearchNode[] }
    | { type: 'not'; child: SearchNode };

// ─── Tokenizer ────────────────────────────────────────────────────────────────

type Token =
    | { type: 'TERM'; value: string }
    | { type: 'PHRASE'; value: string }
    | { type: 'AND' }
    | { type: 'OR' }
    | { type: 'NOT' }
    | { type: 'NEG' }   // `-` shorthand for NOT, at token boundary
    | { type: 'LPAREN' }
    | { type: 'RPAREN' };

function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const n = input.length;

    while (i < n) {
        const ch = input[i];

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

        if (ch === '"') {
            i++;
            const start = i;
            while (i < n && input[i] !== '"') i++;
            const value = input.slice(start, i);
            if (i < n) i++;
            if (value !== '') tokens.push({ type: 'PHRASE', value });
            continue;
        }

        if (ch === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
        if (ch === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }

        // `-` at token boundary (preceded by whitespace/start/paren) = NOT shorthand,
        // but only when the very next char is non-whitespace. `foo-bar` is handled by
        // the bare-term scan below since `f` enters that branch first.
        if (ch === '-') {
            const next = i + 1 < n ? input[i + 1] : '';
            if (next && next !== ' ' && next !== '\t' && next !== '\n' && next !== '\r') {
                tokens.push({ type: 'NEG' });
                i++;
                continue;
            }
        }

        // bare term: anything that isn't whitespace / " / ( / )
        const start = i;
        while (i < n) {
            const c = input[i];
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '"' || c === '(' || c === ')') break;
            i++;
        }
        const value = input.slice(start, i);
        if (value === 'AND') tokens.push({ type: 'AND' });
        else if (value === 'OR') tokens.push({ type: 'OR' });
        else if (value === 'NOT') tokens.push({ type: 'NOT' });
        else if (value !== '') tokens.push({ type: 'TERM', value });
    }

    return tokens;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

class Parser {
    private tokens: Token[];
    private pos = 0;

    constructor(tokens: Token[]) { this.tokens = tokens; }

    private peek(): Token | undefined { return this.tokens[this.pos]; }
    private consume(): Token | undefined { return this.tokens[this.pos++]; }

    private canStartUnary(tok: Token | undefined): boolean {
        if (!tok) return false;
        return tok.type === 'TERM' || tok.type === 'PHRASE' || tok.type === 'LPAREN'
            || tok.type === 'NOT' || tok.type === 'NEG';
    }

    parseExpr(): SearchNode | null { return this.parseOr(); }

    private parseOr(): SearchNode | null {
        let left = this.parseAnd();
        while (this.peek()?.type === 'OR') {
            this.consume();
            const right = this.parseAnd();
            if (right === null) break;
            if (left === null) { left = right; continue; }
            left = { type: 'or', children: [left, right] };
        }
        return left;
    }

    private parseAnd(): SearchNode | null {
        let left = this.parseUnary();
        while (true) {
            const next = this.peek();
            if (next?.type === 'AND') {
                this.consume();
                const right = this.parseUnary();
                if (right === null) break;
                if (left === null) { left = right; continue; }
                left = { type: 'and', children: [left, right] };
            } else if (this.canStartUnary(next)) {
                const right = this.parseUnary();
                if (right === null) break;
                if (left === null) { left = right; continue; }
                left = { type: 'and', children: [left, right] };
            } else {
                break;
            }
        }
        return left;
    }

    private parseUnary(): SearchNode | null {
        const tok = this.peek();
        if (tok?.type === 'NOT' || tok?.type === 'NEG') {
            this.consume();
            const operand = this.parseUnary();
            if (operand === null) return null;
            return { type: 'not', child: operand };
        }
        return this.parsePrimary();
    }

    private parsePrimary(): SearchNode | null {
        const tok = this.peek();
        if (!tok) return null;

        if (tok.type === 'TERM') { this.consume(); return { type: 'term', value: tok.value }; }
        if (tok.type === 'PHRASE') { this.consume(); return { type: 'phrase', value: tok.value }; }
        if (tok.type === 'LPAREN') {
            this.consume();
            const inner = this.parseExpr();
            if (this.peek()?.type === 'RPAREN') this.consume();
            return inner;
        }
        return null;
    }
}

function hasPositiveLeaf(node: SearchNode): boolean {
    switch (node.type) {
        case 'term':
        case 'phrase':
            return true;
        case 'and':
        case 'or':
            return node.children.some(hasPositiveLeaf);
        case 'not':
            return false;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Parse a raw query string into an AST. Never throws. Returns null for empty/only-negative queries. */
export function parseQuery(raw: string): SearchNode | null {
    const tokens = tokenize(raw);
    if (tokens.length === 0) return null;
    const node = new Parser(tokens).parseExpr();
    if (node === null || !hasPositiveLeaf(node)) return null;
    return node;
}

/** Evaluate the AST against a trace's combined searchable text. */
export function matchTrace(node: SearchNode, searchText: string): boolean {
    const lower = searchText.toLowerCase();
    function eval_(n: SearchNode): boolean {
        switch (n.type) {
            case 'term':
            case 'phrase':
                return lower.includes(n.value.toLowerCase());
            case 'and':
                return n.children.every(eval_);
            case 'or':
                return n.children.some(eval_);
            case 'not':
                return !eval_(n.child);
        }
    }
    return eval_(node);
}

/** Flatten positive leaves (term + phrase values) for the highlighter. */
export function collectHighlightTargets(node: SearchNode): string[] {
    switch (node.type) {
        case 'term':
        case 'phrase':
            return [node.value];
        case 'and':
        case 'or':
            return node.children.flatMap(collectHighlightTargets);
        case 'not':
            return [];
    }
}
