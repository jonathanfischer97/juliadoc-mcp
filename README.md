# Julia Documentation MCP Server

An MCP server that provides access to Julia documentation and source code through Claude Desktop.

<a href="https://glama.ai/mcp/servers/7xy80o4wdp"><img width="380" height="200" src="https://glama.ai/mcp/servers/7xy80o4wdp/badge" alt="Julia Documentation Server MCP server" /></a>

## Features

- Get documentation for Julia packages, modules, types, functions, and methods
- View source code for Julia functions, types, and methods
- Built-in caching with 5-minute TTL
- Proper error handling for Julia-specific errors

## Tools

### get-doc
Gets Julia documentation for a package, module, type, function, or method.
- Parameter: `path` (string) - Path to Julia object (e.g., 'Base.sort', 'AbstractArray')

### get-source
Gets Julia source code for a function, type, or method.
- Parameter: `path` (string) - Path to Julia object (e.g., 'Base.sort', 'AbstractArray')

## Requirements

- Node.js 16 or higher
- Julia 1.9 or higher installed and accessible in PATH
- Claude Desktop

## Installation

```bash
npm install -g @jonathanfischer97/server-juliadoc
```

## Configuration

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "juliadoc": {
      "command": "npx",
      "args": ["-y", "@jonathanfischer97/server-juliadoc"]
    }
  }
}
```

If you have a custom Julia installation or configuration, you can specify the paths:

```json
{
  "mcpServers": {
    "juliadoc": {
      "command": "npx",
      "args": ["-y", "@jonathanfischer97/server-juliadoc"],
      "env": {
        "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/path/to/your/julia/bin",
        "JULIA_DEPOT_PATH": "/path/to/your/.julia"
      }
    }
  }
}
```

The server will:
1. Use the system's default Julia installation if no PATH is specified
2. Use the default Julia package depot (~/.julia) if no JULIA_DEPOT_PATH is specified

## Development

```bash
# Clone the repository
git clone https://github.com/jonathanfischer97/juliadoc-mcp.git
cd juliadoc-mcp

# Install dependencies
npm install

# Build
npm run build

# Start server locally
npm start
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details


