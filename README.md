# Julia Documentation MCP Server

An MCP server that provides access to Julia documentation and source code through Claude Desktop.

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
- Julia installed and accessible in PATH
- Claude Desktop

## Installation

```bash
npm install -g @modelcontextprotocol/server-juliadoc
```

## Configuration

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "juliadoc": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-juliadoc"]
    }
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Start server
npm start
```