#!/usr/bin/env node

// Add immediate logging before any imports or class definitions
console.error('Process environment at startup:', {
  argv: process.argv,
  env: process.env,
  cwd: process.cwd()
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get the equivalent of __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Convert exec to use promises instead of callbacks
const execAsync = promisify(exec);

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf8')
);

// Cache implementation to store results and reduce Julia process spawns
class Cache<T> {
  private cache = new Map<string, { value: T; timestamp: number }>();
  private ttl: number;

  constructor(ttlSeconds: number = 300) { // Default 5 minute TTL
    this.ttl = ttlSeconds * 1000; // Convert to milliseconds
  }

  get(key: string): T | undefined {
    const item = this.cache.get(key);
    if (!item) return undefined;
    // Check if cache entry has expired
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
  private juliaPath: string;
  private projectPath: string | null;

  constructor() {
    this.server = new McpServer({
      name: "juliadoc",
      version: packageJson.version,
    });

    this.cache = new Cache<string>(300);
    this.juliaPath = this.findJuliaPath();
    
    // Log all environment variables for debugging
    console.error('Environment variables:', {
      JULIA_PROJECT: process.env.JULIA_PROJECT,
      JULIA_DEPOT_PATH: process.env.JULIA_DEPOT_PATH,
      JULIA_LOAD_PATH: process.env.JULIA_LOAD_PATH,
      PATH: process.env.PATH
    });
    
    // Store project path from environment
    this.projectPath = process.env.JULIA_PROJECT || null;
    console.error('Using Julia project path:', this.projectPath);
    
    this.verifyJuliaInstallation();
    this.setupTools();
  }

  private findJuliaPath(): string {
    // First check if explicitly set via env var
    if (process.env.JULIA_PATH) {
      return process.env.JULIA_PATH;
    }

    const home = homedir();
    const commonPaths = [
      // Juliaup installation (most common)
      `${home}/.juliaup/bin/julia`,
      // Homebrew installation
      '/opt/homebrew/bin/julia',
      // Manual installation
      '/Applications/Julia-1.9.app/Contents/Resources/julia/bin/julia',
      // System-wide installation
      '/usr/local/bin/julia'
    ];

    // Check common installation paths
    for (const path of commonPaths) {
      if (existsSync(path)) {
        console.error(`Found Julia at: ${path}`);
        return path;
      }
    }

    // Fall back to PATH-based julia
    console.error('Falling back to Julia from system PATH');
    return 'julia';
  }

  private async verifyJuliaInstallation(): Promise<void> {
    try {
      const { stdout } = await execAsync(`${this.juliaPath} --version`);
      console.error(`Found Julia: ${stdout.trim()}`);
    } catch (error) {
      console.error('Failed to find Julia installation:', error);
      throw new Error(
        'Julia not found. Please ensure Julia is installed and either:\n' +
        '1. Add Julia to your PATH, or\n' +
        '2. Set JULIA_PATH environment variable to point to your Julia executable'
      );
    }
  }

  private async runJuliaCommand(code: string, packageName?: string): Promise<string> {
    try {
      let fullCode = '';
      
      // Add package loading if specified
      if (packageName) {
        fullCode += `using ${packageName}; `;
      }

      // Add the main code
      fullCode += code;
      
      // Properly escape the code for the -e flag
      // Replace single quotes with '\'' for shell escaping
      const escapedCode = fullCode.replace(/'/g, "'\\''");
      
      // Properly quote the project path if specified
      const projectFlag = this.projectPath ? 
        `--project='${this.projectPath.replace(/'/g, "'\\''")}'` : 
        '';
      
      // Construct the full command
      const command = `${this.juliaPath} ${projectFlag} -e '${escapedCode}'`;
      
      console.error(`Executing command: ${command}`);
      
      // Execute with explicit environment
      const { stdout, stderr } = await execAsync(command, {
        env: {
          ...process.env,
          // Ensure JULIA_PROJECT is set in the environment
          JULIA_PROJECT: this.projectPath || '',
          // Preserve other important Julia env vars
          JULIA_DEPOT_PATH: process.env.JULIA_DEPOT_PATH,
          JULIA_LOAD_PATH: process.env.JULIA_LOAD_PATH,
          PATH: process.env.PATH,
        }
      });
      
      console.error('Command output:', stdout, stderr);
      
      if (stderr) {
        // Run diagnostics when we hit an error to help debug
        const diagnosticCommand = `${this.juliaPath} ${projectFlag} -e 'println("Active project: ", Base.active_project()); println("DEPOT_PATH: ", DEPOT_PATH); using Pkg; println("Installed packages:"); Pkg.status()'`;
        console.error('Running diagnostics:', diagnosticCommand);
        const { stdout: diagnosticOutput } = await execAsync(diagnosticCommand);
        
        if (stderr.includes("Package") && stderr.includes("not found in current path")) {
          throw new Error(
            `Package ${packageName} not found in the current project environment.\n` +
            `Environment Info:\n${diagnosticOutput}\n` +
            `If using a custom project (JULIA_PROJECT), make sure to add the package first:\n` +
            `julia> using Pkg; Pkg.add("${packageName}")`
          );
        } else if (stderr.includes("could not load package")) {
          throw new Error(`Package not found: ${stderr}\n${diagnosticOutput}`);
        } else if (stderr.includes("not found")) {
          throw new Error(`Symbol not found: ${stderr}\n${diagnosticOutput}`);
        } else if (stderr.includes("UndefVarError")) {
          throw new Error(`Package not loaded. Try installing the package first.\n${diagnosticOutput}`);
        }
        throw new Error(`${stderr}\n${diagnosticOutput}`);
      }
      
      if (!stdout.trim()) {
        throw new Error("No documentation found");
      }
      
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
    // Tool 1: Get documentation with flexible detail levels
    this.server.tool(
      "get-doc",
      "Get Julia documentation for a package, module, type, function, or method",
      {
        path: z.string().describe("Path to Julia object (e.g., 'Base.sort', 'StatsBase.transform')"),
        detail_level: z.enum(["concise", "full", "all"]).optional()
          .describe("Level of documentation detail: concise (just signatures), full (standard docs), or all (including internals)"),
        include_unexported: z.boolean().optional()
          .describe("Whether to include unexported symbols")
      },
      async ({ path, detail_level = "full", include_unexported = false }) => {
        try {
          // Extract package name if it's a qualified path
          const packageMatch = path.match(/^([A-Za-z][A-Za-z0-9_]*)\./);
          const packageName = packageMatch ? packageMatch[1] : null;
          
          // Skip package loading for Base
          if (packageName && packageName !== 'Base') {
            // Build appropriate Julia command based on detail level
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

            // Override command if including unexported symbols
            if (include_unexported) {
              command = `
                using InteractiveUtils
                names(${path}, all=true) |> 
                filter(n -> !startswith(string(n), "#")) |>
                sort |>
                foreach(n -> println("\\n", "-"^40, "\\n", @doc getfield(${path}, n)))
              `;
            }

            return {
              content: [{
                type: "text",
                text: await this.runJuliaCommand(command, packageName)
              }]
            };
          } else {
            // Same command building logic for Base/non-package objects
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

            return {
              content: [{
                type: "text",
                text: await this.runJuliaCommand(command)
              }]
            };
          }
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: error instanceof Error ? error.message : String(error)
            }]
          };
        }
      }
    );

    // Tool 2: List package contents
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
            using ${path}  # Load the package first
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
      }
    );

    // Tool 3: Explore project structure
    this.server.tool(
      "explore-project",
      "Explore a Julia project's structure and dependencies",
      {
        path: z.string().describe("Path to Julia project")
      },
      async ({ path }) => {
        try {
          // Read and display Project.toml contents
          const command = `
            using Pkg
            project = Pkg.Types.read_project(joinpath("${path}", "Project.toml"))
            println("Project: ", project.name, " v", project.version)
            println("\\nDependencies:")
            for (dep, uuid) in project.deps
              println(" - ", dep, " = ", uuid)
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

    // Tool 4: Get source code with context
    this.server.tool(
      "get-source",
      "Get Julia source code for a function, type, or method",
      {
        path: z.string().describe("Path to Julia object (e.g., 'Base.sort', 'StatsBase.transform')"),
      },
      async ({ path }) => {
        console.error(`Received get-source request for path: ${path}`);
        const cacheKey = `source:${path}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
          console.error(`Returning cached source for ${path}`);
          return {
            content: [{ type: "text", text: cached }],
          };
        }

        try {
          // Extract package name if it's a qualified path
          const packageMatch = path.match(/^([A-Za-z][A-Za-z0-9_]*)\./);
          const packageName = packageMatch ? packageMatch[1] : null;
          
          // Build the command, loading package if needed
          const command = `
            ${packageName && packageName !== 'Base' ? `using ${packageName}` : ''}
            using InteractiveUtils

            # Helper function to find where a method definition ends
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

            # Function to display method information with context
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

            # Get all methods and display their source
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
          `;
          
          const source = await this.runJuliaCommand(command);
          this.cache.set(cacheKey, source);
          return {
            content: [{ type: "text", text: source }],
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

  // Start the MCP server
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Julia Documentation MCP Server running on stdio");
  }

  // Clean up resources when shutting down
  cleanup(): void {
    // Clear cache
    this.cache = new Cache<string>(0);
    // Ensure all pending Julia processes are terminated
    process.exit(0);
  }
}

// Initialize and start the server
async function main() {
  const server = new JuliaDocServer();
  
  // Handle shutdown signals
  process.on("SIGINT", () => server.cleanup());
  process.on("SIGTERM", () => server.cleanup());
  
  try {
    await server.start();
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

// Start the server and handle any startup errors
main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
}); 