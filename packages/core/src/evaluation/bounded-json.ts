import { encodeEvaluationCanonicalJson } from "@proofstack/contracts";

export const MAX_BOUNDED_JSON_DEPTH = 64;

export class BoundedJsonParseError extends SyntaxError {
  constructor(
    readonly characterOffset: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${message} at character offset ${characterOffset}`, options);
    this.name = "BoundedJsonParseError";
  }
}

export interface BoundedJsonParseResult {
  readonly nodeCount: number;
  readonly value: unknown;
}

class JsonScanner {
  private index = 0;
  private nodes = 0;

  constructor(
    private readonly text: string,
    private readonly maximumNodes: number,
  ) {}

  parse(): number {
    this.skipWhitespace();
    this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("Unexpected content after the JSON value");
    return this.nodes;
  }

  private fail(message: string): never {
    throw new BoundedJsonParseError(this.index, message);
  }

  private countNode(): void {
    this.nodes += 1;
    if (this.nodes > this.maximumNodes) this.fail("JSON node limit exceeded");
  }

  private parseValue(depth: number): void {
    if (depth > MAX_BOUNDED_JSON_DEPTH) this.fail("JSON nesting depth exceeded");
    this.countNode();
    const character = this.text[this.index];
    if (character === "{") {
      this.parseObject(depth);
      return;
    }
    if (character === "[") {
      this.parseArray(depth);
      return;
    }
    if (character === '"') {
      this.parseString();
      return;
    }
    if (character === "t") {
      this.parseLiteral("true");
      return;
    }
    if (character === "f") {
      this.parseLiteral("false");
      return;
    }
    if (character === "n") {
      this.parseLiteral("null");
      return;
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      this.parseNumber();
      return;
    }
    this.fail("Expected a JSON value");
  }

  private parseObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      if (this.text[this.index] !== '"') this.fail("Expected an object property name");
      const key = this.parseString();
      if (keys.has(key)) this.fail(`Duplicate object property ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.fail("Expected a colon after the property name");
      this.index += 1;
      this.skipWhitespace();
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "}") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.fail("Expected a comma or closing object brace");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return;
    }
    for (;;) {
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "]") {
        this.index += 1;
        return;
      }
      if (separator !== ",") this.fail("Expected a comma or closing array bracket");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    for (;;) {
      const character = this.text[this.index];
      if (character === undefined) this.fail("Unterminated JSON string");
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch (error) {
          throw new BoundedJsonParseError(start, "Invalid JSON string", { cause: error });
        }
      }
      if (character === "\\") {
        this.index += 1;
        const escapeCode = this.text[this.index];
        if (escapeCode === "u") {
          for (let offset = 1; offset <= 4; offset += 1) {
            const digit = this.text[this.index + offset];
            if (digit === undefined || !/[0-9a-fA-F]/.test(digit)) {
              this.fail("Invalid Unicode escape in JSON string");
            }
          }
          this.index += 5;
          continue;
        }
        if (escapeCode === undefined || !'"\\/bfnrt'.includes(escapeCode)) {
          this.fail("Invalid escape in JSON string");
        }
        this.index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.fail("Unescaped control character in JSON string");
      this.index += 1;
    }
  }

  private parseLiteral(literal: "false" | "null" | "true"): void {
    if (!this.text.startsWith(literal, this.index)) this.fail(`Invalid ${literal} literal`);
    this.index += literal.length;
  }

  private parseNumber(): void {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") {
      this.index += 1;
      const next = this.text[this.index];
      if (next !== undefined && next >= "0" && next <= "9") {
        this.fail("JSON numbers cannot contain leading zeroes");
      }
    } else {
      this.consumeDigits(true);
    }
    if (this.text[this.index] === ".") {
      this.index += 1;
      this.consumeDigits(true);
    }
    const exponent = this.text[this.index];
    if (exponent === "e" || exponent === "E") {
      this.index += 1;
      const sign = this.text[this.index];
      if (sign === "+" || sign === "-") this.index += 1;
      this.consumeDigits(true);
    }
    if (this.index === start) this.fail("Invalid JSON number");
  }

  private consumeDigits(requireOne: boolean): void {
    const start = this.index;
    while (true) {
      const character = this.text[this.index];
      if (character === undefined || character < "0" || character > "9") break;
      this.index += 1;
    }
    if (requireOne && this.index === start) this.fail("Expected a digit in JSON number");
  }

  private skipWhitespace(): void {
    while (true) {
      const character = this.text[this.index];
      if (character !== " " && character !== "\n" && character !== "\r" && character !== "\t") {
        return;
      }
      this.index += 1;
    }
  }
}

/** Parses strict UTF-8 JSON while rejecting duplicate keys, excessive depth, and excessive nodes. */
export function parseBoundedJson(bytes: Uint8Array, maximumNodes: number): BoundedJsonParseResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new BoundedJsonParseError(0, "JSON is not valid UTF-8", { cause: error });
  }
  if (!Number.isSafeInteger(maximumNodes) || maximumNodes < 1) {
    throw new RangeError("The JSON node limit must be a positive safe integer");
  }
  const nodeCount = new JsonScanner(text, maximumNodes).parse();
  try {
    const value = JSON.parse(text) as unknown;
    encodeEvaluationCanonicalJson(value);
    return { nodeCount, value };
  } catch (error) {
    throw new BoundedJsonParseError(0, "JSON cannot be represented canonically", { cause: error });
  }
}
