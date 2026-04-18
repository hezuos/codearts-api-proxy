/**
 * tools-definition.mjs — Tool definitions matching what CodeArts Agent IDE sends
 * Extracted from extension.js s20() function.
 * Descriptions are shortened for readability but structure is exact.
 */

export const DEFAULT_TOOLS = [
  {
    type: "function",
    function: {
      name: "Task",
      description:
        "Launch a new agent to handle complex, multistep tasks autonomously.\n\nWhen to use the Task tool:\n- Complex research tasks\n- Multi-step tasks\n\nAvailable agent types:\n- explore: Fast agent for exploring codebases\n- general: General-purpose agent",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "A short (3-5 word) description of the task",
          },
          prompt: {
            type: "string",
            description: "The task for the agent to perform",
          },
          subagent_type: {
            type: "string",
            description: "The type of specialized agent to use for this task",
          },
        },
        required: ["description", "prompt", "subagent_type"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description:
        "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nCurrent shell environment: PowerShell. Generate commands compliant with the PowerShell environment.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The command to execute",
          },
          timeout: {
            type: "number",
            description: "Optional timeout in milliseconds (max 600000)",
          },
          description: {
            type: "string",
            description:
              "Clear, concise description of what this command does in 5-10 words",
          },
          run_in_background: {
            type: "boolean",
            description: "Set to true to run this command in the background.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description:
        '- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns',
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The glob pattern to match files against",
          },
          path: {
            type: "string",
            description:
              "The directory to search in. If not specified, the current working directory will be used.",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description:
        "- Fast content search tool that works with any codebase size\n- Searches file contents using regular expressions\n- Supports full regex syntax\n- Filter files by pattern with the include parameter\n- Returns file paths and line numbers with at least one match",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The regex pattern to search for in file contents",
          },
          path: {
            type: "string",
            description: "The directory to search in.",
          },
          include: {
            type: "string",
            description: 'File pattern to include in the search (e.g. "*.js")',
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Read",
      description:
        "Reads a file from the local filesystem.\n\nUsage:\n- The file_path parameter must be an absolute path\n- By default, it reads up to 2000 lines starting from the beginning of the file\n- You can optionally specify a line offset and limit\n- Results are returned using cat -n format, with line numbers starting at 1",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The absolute path to the file to read",
          },
          offset: {
            type: "number",
            description: "The line number to start reading from",
          },
          limit: {
            type: "number",
            description: "The number of lines to read",
          },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description:
        "Performs exact string replacements in files.\n\nUsage:\n- You must use your `Read` tool at least once before editing\n- ALWAYS prefer editing existing files. NEVER write new files unless explicitly required.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The absolute path to the file to modify",
          },
          old_string: {
            type: "string",
            description: "The text to replace",
          },
          new_string: {
            type: "string",
            description: "The text to replace it with",
          },
          replace_all: {
            type: "boolean",
            default: false,
            description: "Replace all occurrences of old_string",
          },
        },
        required: ["file_path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description:
        "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The absolute path to the file to write",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["file_path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TodoWrite",
      description:
        "Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string", minLength: 1 },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
                activeForm: { type: "string", minLength: 1 },
              },
              required: ["content", "status", "activeForm"],
              additionalProperties: false,
            },
            description: "The updated todo list",
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_followup_question",
      description:
        "Ask the user a question to gather additional information needed to complete the task.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user.",
          },
          options: {
            type: "array",
            description: "A list of 2-4 option answers.",
            items: { type: "string" },
            minItems: 2,
            maxItems: 4,
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyzeImage",
      description:
        "Analyse image or images by ID and extract information such as OCR text, objects, layout, colors, or safety signals.",
      parameters: {
        type: "object",
        properties: {
          imageId: {
            type: "array",
            description: "an array of IDs to analyse",
            items: { type: "string" },
          },
          task: {
            type: "string",
            description: "Details of task to perform on the image.",
          },
          regions: {
            type: "array",
            description: "Optional regions of interest within the image",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
                units: { type: "string", enum: ["px", "pct"] },
              },
              required: ["x", "y", "w", "h", "units"],
            },
          },
        },
        required: ["imageId", "task"],
      },
    },
  },
];
