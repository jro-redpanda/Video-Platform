import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const outputRoot = process.env.ORVAL_OUTPUT_ROOT;
const apiClientReactSrc = outputRoot
  ? path.resolve(outputRoot, "api-client-react", "src")
  : path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = outputRoot
  ? path.resolve(outputRoot, "api-zod", "src")
  : path.resolve(root, "lib", "api-zod", "src");

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";
  const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
  for (const [route, pathItem] of Object.entries(config.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of methods) {
      if (pathItem[method]?.["x-internal"] === true) delete pathItem[method];
    }
    if (!methods.some((method) => pathItem[method])) delete config.paths?.[route];
  }

  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: true,
      indexFiles: false,
      prettier: true,
      override: {
        zod: {
          version: 3,
          coerce: {
            query: ['boolean', 'number', 'string'],
            param: ['boolean', 'number', 'string'],
            body: ['bigint', 'date'],
            response: ['bigint', 'date'],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
