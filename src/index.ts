#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Simple cache implementation
class Cache<T> {
  private cache = new Map<string, { value: T; timestamp: number }>();
  private ttl: number;

  constructor(ttlSeconds: number = 300) {
    this.ttl = ttlSeconds * 1000;
  }

  get(key: string): T | undefined {
    const item = this.cache.get(key);
    if (!item) return undefined;
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key: string, value: T): void {
    this.cache.set(key, { value, timestamp: Date.now() });
  }
}

class JuliaDocServer {
  private server: McpServer;
  private cache: Cache<string>;

  constructor() {
    this.server = new McpServer({
      name: "juliadoc",
      version: "1.0.0",
    });

    this.cache = new Cache<string>(300); // 5 minute cache

    // Register tools
    this.setupTools();
  }

  private async runJuliaCommand(code: string): Promise<string> {
    try {
      // Escape the Julia code for shell execution
      const escapedCode = code.replace(/"/g, '\\"');
      const command = `julia -e "${escapedCode}"`;
      console.error(`Executing Julia command: ${command}`);
      
      // Print Julia version and environment info for debugging
      const { stdout: juliaInfo } = await execAsync('julia -e "println(\\"Julia Version: \\", VERSION); println(\\"DEPOT_PATH: \\", DEPOT_PATH)"');
      console.error("Julia environment info:", juliaInfo);
      
      const { stdout, stderr } = await execAsync(command);
      
      if (stderr) {
        console.error(`Julia stderr output: ${stderr}`);
        if (stderr.includes("could not load package")) {
          throw new Error(`Package not found: ${stderr}`);
        } else if (stderr.includes("not found")) {
          throw new Error(`Symbol not found: ${stderr}`);
        } else if (stderr.includes("UndefVarError")) {
          throw new Error(`Undefined variable: ${stderr}`);
        }
        throw new Error(stderr);
      }
      
      if (!stdout.trim()) {
        throw new Error("No documentation found");
      }
      
      console.error(`Julia stdout output: ${stdout}`);
      return stdout.trim();
    } catch (error) {
      console.error(`Julia command error:`, error);
      if (error instanceof Error) {
        if (error.message.includes("ENOENT")) {
          throw new Error("Julia executable not found. Please ensure Julia is installed and in your PATH.");
        }
        throw new Error(`Julia error: ${error.message}`);
      }
      throw error;
    }
  }

  private setupTools(): void {
    // Get documentation with flexible detail levels
    this.server.tool(
      "get-doc",
      "Get Julia documentation for a package, module, type, function, or method",
      {
        path: z.string().describe("Path to Julia object (e.g., 'Base.sort', 'AbstractArray')"),
        detail_level: z.enum(["concise", "full", "all"]).optional()
          .describe("Level of documentation detail: concise (just signatures), full (standard docs), or all (including internals)"),
        include_unexported: z.boolean().optional()
          .describe("Whether to include unexported symbols")
      },
      async ({ path, detail_level = "full", include_unexported = false }) => {
        console.error(`Received get-doc request for path: ${path}`);
        const cacheKey = `doc:${path}:${detail_level}:${include_unexported}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
          console.error(`Returning cached documentation for ${path}`);
          return {
            content: [{ type: "text", text: cached }],
          };
        }

        try {
          let command = "";
          switch (detail_level) {
            case "concise":
              command = `
                using InteractiveUtils
                m = @which ${path}
                println("Type signature: ", m.sig)
              `;
              break;
            case "all":
              command = `
                using InteractiveUtils
                # Get main documentation
                println(@doc ${path})
                println("\\n", "-"^40, "\\n")
                # Get all methods if it's a function
                ms = methods(${path})
                if !isempty(ms)
                  println("Method signatures:")
                  for m in ms
                    println(" - ", m.sig)
                  end
                end
                # Show internal fields if it's a type
                if isa(${path}, Type)
                  println("\\nFields:")
                  for field in fieldnames(${path})
                    println(" - ", field, "::", fieldtype(${path}, field))
                  end
                end
              `;
              break;
            default: // "full"
              command = `println(@doc ${path})`;
          }

          if (include_unexported) {
            command = `
              using InteractiveUtils
              names(${path}, all=true) |> 
              filter(n -> !startswith(string(n), "#")) |>
              sort |>
              foreach(n -> println("\\n", "-"^40, "\\n", @doc getfield(${path}, n)))
            `;
          }

          const doc = await this.runJuliaCommand(command);
          this.cache.set(cacheKey, doc);
          return {
            content: [{ type: "text", text: doc }],
          };
        } catch (error) {
          console.error(`Error getting documentation for ${path}:`, error);
          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );

    // List package contents
    this.server.tool(
      "list-package",
      "List available symbols in a Julia package or module",
      {
        path: z.string().describe("Package or module name"),
        include_unexported: z.boolean().optional()
          .describe("Whether to include unexported symbols")
      },
      async ({ path, include_unexported = false }) => {
        try {
          const command = `
            using InteractiveUtils
            module_obj = ${path}
            names(module_obj, all=${include_unexported}) |>
            filter(n -> !startswith(string(n), "#")) |>
            sort |>
            map(n -> (n, string(typeof(getfield(module_obj, n))))) |>
            foreach(t -> println(t[2], " ", t[1]))
          `;
          
          const result = await this.runJuliaCommand(command);
          return {
            content: [{ type: "text", text: result }],
          };
        } catch (error) {
          console.error(`Error listing package contents for ${path}:`, error);
          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );

    // Explore project structure
    this.server.tool(
      "explore-project",
      "Explore a Julia project's structure and dependencies",
      {
        path: z.string().describe("Path to Julia project")
      },
      async ({ path }) => {
        try {
          const command = `
            using Pkg
            project = Pkg.Types.read_project(joinpath("${path}", "Project.toml"))
            println("Project: ", project.name, " v", project.version)
            println("\\nDependencies:")
            for (dep, ver) in project.dependencies
              println(" - ", dep, " = ", ver)
            end
          `;
          
          const result = await this.runJuliaCommand(command);
          return {
            content: [{ type: "text", text: result }],
          };
        } catch (error) {
          console.error(`Error exploring project at ${path}:`, error);
          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );

    // Get source code
    this.server.tool(
      "get-source",
      "Get Julia source code for a function, type, or method",
      {
        path: z.string().describe("Path to Julia object (e.g., 'Base.sort', 'AbstractArray')"),
      },
      async ({ path }) => {
        console.error(`Received get-source request for path: ${path}`);
        const cacheKey = `source:${path}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
          console.error(`Returning cached source for ${path}`);
          return {
            content: [
              {
                type: "text",
                text: cached,
              },
            ],
          };
        }

        try {
          const source = await this.runJuliaCommand(`
            using InteractiveUtils

            function find_method_end(lines, start_line)
              # Get base indentation of the method definition
              base_indent = length(match(r"^\\s*", lines[start_line]).match)
              nesting_level = 0
              
              # Look forward for the matching end
              for i in start_line:length(lines)
                line = lines[i]
                if !isempty(strip(line))
                  # Count nested blocks by looking for increased indentation followed by certain keywords
                  if match(r"^\\s*(function|if|for|while|let|try|begin|module|struct|macro)\\b", line) !== nothing
                    nesting_level += 1
                  end
                  
                  # Check for end keywords
                  if endswith(strip(line), "end")
                    nesting_level -= 1
                    # If we're back to the original nesting level, this is our end
                    if nesting_level == 0
                      return i
                    end
                  end
                end
              end
              
              # If we didn't find the end, return the last line
              return length(lines)
            end

            function show_method_info(m)
              println("Type signature: ", m.sig)
              println("-" ^ 40)
              try
                file, line = functionloc(m)
                println("Source location: ", file, ":", line)
                println("-" ^ 40)
                
                # Read the source file
                if isfile(file)
                  # Read the entire file content
                  content = read(file, String)
                  lines = split(content, "\\n")
                  
                  # Show some context before the method
                  start_line = max(1, line - 5)
                  
                  # Find the actual end of this method
                  end_line = find_method_end(lines, line)
                  
                  # Add a few lines of context after
                  end_line = min(length(lines), end_line + 5)
                  
                  # Print lines with line numbers
                  for i = start_line:end_line
                    linenum = string(i)
                    linetext = i <= length(lines) ? lines[i] : ""
                    if i == line
                      println("➜ ", linenum, ": ", linetext)  # Highlight the definition line
                    else
                      println("  ", linenum, ": ", linetext)
                    end
                  end
                else
                  println("Could not find source file")
                end
              catch e
                println("Error retrieving source: ", e)
                println(sprint(showerror, e, catch_backtrace()))
              end
              println()
            end

            # Get all methods
            ms = methods(${path})
            if isempty(ms)
              println("No methods found for ${path}")
            else
              println("Found ", length(ms), " method(s):")
              println()
              for (i, m) in enumerate(ms)
                println("Method ", i, ":")
                show_method_info(m)
              end
            end
          `);
          this.cache.set(cacheKey, source);
          return {
            content: [
              {
                type: "text",
                text: source,
              },
            ],
          };
        } catch (error) {
          console.error(`Error getting source for ${path}:`, error);
          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Julia Documentation MCP Server running on stdio");
  }

  cleanup(): void {
    // Add any cleanup needed
    process.exit(0);
  }
}

// Start server
async function main() {
  const server = new JuliaDocServer();
  
  // Handle cleanup
  process.on("SIGINT", () => server.cleanup());
  process.on("SIGTERM", () => server.cleanup());
  
  try {
    await server.start();
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
}); 