import type {
  HttpImplementation,
  JSONValue,
  ToolDefinition,
} from "@scaffold/schema/integrations";
import { describe, expect, it } from "vitest";
import { httpSerializationFixtures } from "../../../scripts/m2-contract-fixtures.mjs";
import {
  httpInputSchema,
  normalizeHttpTool,
  serializeHttpArguments,
} from "../src/integrations/http";

function definition(implementation: HttpImplementation): ToolDefinition {
  return {
    name: "vectors.serialize",
    description: "Public exact serialization contract vector",
    inputSchema: httpInputSchema(implementation),
    operationClass: "read",
    requirements: {},
    permissions: [
      {
        requirement: null,
        origin: "https://example.com",
        methods: [implementation.method],
        path: "/",
        match: "prefix",
      },
    ],
    implementation,
  };
}

describe("D12 corpus against actual HTTP normalization and serialization", () => {
  for (const fixture of httpSerializationFixtures)
    it(String(fixture.name), () => {
      const location = fixture.location as "path" | "query" | "header",
        key = String(fixture.nameKey ?? "value");
      const implementation: HttpImplementation = {
        kind: "http",
        method: "GET",
        url:
          location === "path"
            ? `https://example.com/{${key}}`
            : "https://example.com/serialize",
        parameters: [
          {
            name: key,
            in: location,
            required: true,
            schema: Array.isArray(fixture.value)
              ? { type: "array", items: { type: "string" } }
              : { type: "string" },
            style: location === "query" ? "form" : "simple",
            explode: fixture.explode === true,
          },
        ],
        response: { mediaType: "application/json" },
      };
      const tool = definition(implementation),
        args: Record<string, JSONValue> = {
          [location === "header" ? "headers" : location]: {
            [key]: fixture.value as JSONValue,
          },
        };
      if (location === "header" && ["Authorization", "Cookie"].includes(key)) {
        expect(() => normalizeHttpTool(tool)).toThrow();
        return;
      }
      const reviewed = normalizeHttpTool(tool).tool;
      if (fixture.valid === false) {
        expect(() => serializeHttpArguments(reviewed, args)).toThrow(
          expect.objectContaining({
            code: "invalid_arguments",
            effect: { state: "not_dispatched" },
          }),
        );
        return;
      }
      const result = serializeHttpArguments(reviewed, args);
      if (location === "path")
        expect(result.url).toBe(`https://example.com/${fixture.expected}`);
      else if (location === "query")
        expect(result.url).toBe(
          `https://example.com/serialize?${fixture.expected}`,
        );
      else expect(result.headers[key]).toBe(fixture.expected);
    });
  it("preserves zero, false and empty strings while absence stays absent", () => {
    const tool = normalizeHttpTool(
      definition({
        kind: "http",
        method: "GET",
        url: "https://example.com/serialize",
        parameters: [
          {
            name: "zero",
            in: "query",
            required: true,
            schema: { type: "number" },
            style: "form",
            explode: true,
          },
          {
            name: "false",
            in: "query",
            required: true,
            schema: { type: "boolean" },
            style: "form",
            explode: true,
          },
          {
            name: "empty",
            in: "query",
            required: true,
            schema: { type: "string" },
            style: "form",
            explode: true,
          },
          {
            name: "absent",
            in: "query",
            required: false,
            schema: { type: "string", default: "must-not-inject" },
            style: "form",
            explode: true,
          },
        ],
        response: { mediaType: "application/json" },
      }),
    ).tool;
    const args = { query: { zero: 0, false: false, empty: "" } };
    expect(serializeHttpArguments(tool, args).url).toBe(
      "https://example.com/serialize?zero=0&false=false&empty=",
    );
    expect(args).toEqual({ query: { zero: 0, false: false, empty: "" } });
    expect(() =>
      serializeHttpArguments(tool, {
        query: { zero: "0", false: "false", empty: "" },
      }),
    ).toThrow();
  });
  it("encodes deterministic form bytes without treating JSON null as an empty field", () => {
    const tool = normalizeHttpTool(
      definition({
        kind: "http",
        method: "POST",
        url: "https://example.com/form",
        parameters: [],
        requestBody: {
          mediaType: "application/x-www-form-urlencoded",
          required: true,
          schema: {
            type: "object",
            properties: {
              zero: { type: "integer" },
              flag: { type: "boolean" },
              empty: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["zero", "flag", "empty", "tags"],
            additionalProperties: false,
          },
        },
        response: { mediaType: "application/json" },
      }),
    ).tool;
    const result = serializeHttpArguments(tool, {
      body: { tags: ["a b", "c+d"], empty: "", flag: false, zero: 0 },
    });
    expect(new TextDecoder().decode(result.body)).toBe(
      "zero=0&flag=false&empty=&tags=a+b&tags=c%2Bd",
    );
    expect(() =>
      serializeHttpArguments(tool, {
        body: { zero: 0, flag: false, empty: null, tags: [] },
      }),
    ).toThrow();
  });
  it("canonicalizes JSON body bytes but never coerces or mutates business input", () => {
    const tool = normalizeHttpTool(
      definition({
        kind: "http",
        method: "POST",
        url: "https://example.com/json",
        parameters: [],
        requestBody: {
          mediaType: "application/json",
          required: true,
          schema: { type: "object" },
        },
        response: { mediaType: "application/json" },
      }),
    ).tool;
    const args = { body: { z: 0, a: { flag: false, empty: "" } } };
    expect(
      new TextDecoder().decode(serializeHttpArguments(tool, args).body),
    ).toBe('{"a":{"empty":"","flag":false},"z":0}');
    expect(args).toEqual({ body: { z: 0, a: { flag: false, empty: "" } } });
  });
});
