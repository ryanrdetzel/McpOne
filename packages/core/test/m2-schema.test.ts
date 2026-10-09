import { describe, expect, it } from "vitest";
import { schemaFixtures } from "../../../scripts/m2-contract-fixtures.mjs";
import { validateInput, validateSchema } from "../src/integrations/schema";

describe("D12 bounded schema and directional validation corpus", () => {
  for (const fixture of schemaFixtures) {
    const options = {
      dialect: fixture.dialect ?? "3.1",
      direction: fixture.direction ?? "request",
    } as const;
    it(`${fixture.name}: schema review`, () => {
      const result = validateSchema(fixture.schema, options);
      expect(result.valid).toBe(fixture.valid);
      if (!fixture.valid) {
        expect(result.issues.length).toBeGreaterThan(0);
        for (const issue of result.issues) {
          expect(issue.path).toMatch(/^(?:$|\/)/);
          expect(issue.message.length).toBeGreaterThan(0);
        }
      }
      if (fixture.warning) expect(result.warnings.length).toBeGreaterThan(0);
    });
    if (!fixture.valid) continue;
    for (const [index, value] of (fixture.accepted ?? []).entries()) {
      it(`${fixture.name}: accepts instance ${index} without mutation`, () => {
        const before = JSON.stringify(value);
        const result = validateInput(fixture.schema, value, options);
        expect(result.valid).toBe(true);
        expect(JSON.stringify(value)).toBe(before);
      });
    }
    for (const [index, value] of (fixture.rejected ?? []).entries()) {
      it(`${fixture.name}: rejects instance ${index} without coercion`, () => {
        const before = JSON.stringify(value);
        const result = validateInput(fixture.schema, value, options);
        expect(result.valid).toBe(false);
        expect(result.issues.length).toBeGreaterThan(0);
        expect(JSON.stringify(value)).toBe(before);
      });
    }
  }
  it("treats __proto__ as data without mutating host object prototypes", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"object"}},"additionalProperties":false}',
    );
    const value = JSON.parse(
      '{"__proto__":{"m2_public_pollution_probe":true}}',
    );
    expect(validateInput(schema, value).valid).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(
        Object.prototype,
        "m2_public_pollution_probe",
      ),
    ).toBeUndefined();
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
  });
  it("leaves an absent default absent", () => {
    const schema = {
      type: "object",
      properties: { value: { type: "integer", default: 3 } },
      additionalProperties: false,
    };
    const value = {};
    expect(validateInput(schema, value).valid).toBe(true);
    expect(value).toEqual({});
  });
});
