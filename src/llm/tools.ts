import type Anthropic from "@anthropic-ai/sdk";

export const FLOOT_TOOLS: Anthropic.Tool[] = [
  {
    name: "eval_js",
    description:
      "Evaluate JavaScript code in a full Node.js environment. Has access to all Node.js built-in modules (fs, path, http, etc). Returns the result of the last expression, or stdout output. Use for calculations, file operations, data processing, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        code: {
          type: "string",
          description: "The JavaScript code to evaluate",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "run_shell",
    description:
      "Run a shell command (bash) and return its stdout and stderr. Use for system commands, file listing, git operations, package management, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to run",
        },
        cwd: {
          type: "string",
          description: "Working directory (optional, defaults to project root)",
        },
      },
      required: ["command"],
    },
  },
];

export const OLLAMA_TOOLS = FLOOT_TOOLS.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  },
}));
