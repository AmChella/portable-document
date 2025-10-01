# XML to TeX Transformation Engine

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

A powerful and flexible Node.js-based engine that transforms XML documents into text-based formats (primarily TeX/LaTeX) using a declarative, template-driven approach. This tool excels at converting structured documents like academic papers, technical documentation, and publications from XML to publication-ready TeX format.

## Features

- **Template-Driven Transformation**: Output structure follows template design, not source XML structure
- **CSS Selector Matching**: Use familiar CSS-like selectors to target XML elements
- **Processing Instructions Support**: Handle XML processing instructions with custom templates
- **Automatic TeX Escaping**: Built-in character escaping for safe TeX output
- **Smart Whitespace Control**: Configurable whitespace preservation and trimming
- **Flexible Placeholder System**: Multiple placeholder types for content, attributes, and delegation
- **Performance Monitoring**: Built-in performance metrics and memory usage tracking
- **Comprehensive Validation**: Reports on unprocessed XML nodes for debugging

## Installation

### Prerequisites
- Node.js 14.0.0 or higher
- npm or yarn

### Install Dependencies

```bash
npm install
```

### Global Installation (Optional)

To use the `transform-xml` command globally:

```bash
npm link
# Now you can use: transform-xml <xml-file> <template-file> [output-file]
```

#### Rich document demo

The repository ships with a feature-rich `template/document.xml` sample that exercises sections, notes, math environments, lists, figures, and TikZ graphics. Use the dedicated TeX template to generate print-ready output:

```bash
node src/cli.js template/document.xml template/document.tex.xml document.tex
node src/tex-to-pdf.js document.tex
```

## Quick Start

### 1. Prepare your files

Create a simple XML document (`document.xml`):
```xml
<?xml version="1.0"?>
<article>
    <head>
        <ce:title id="title1">Hello World Example</ce:title>
    </head>
    <body>
        <p id="p1">This is a sample paragraph.</p>
        <ce:italic>emphasized text</ce:italic>
    </body>
</article>
```

Create a template file (`template.xml`):
```xml
<templates>
    <template data-xml-selector="article">\documentclass{article}
\begin{document}
[[...]]
\end{document}</template>
    <template data-xml-selector="head">[[...]]</template>
    <template data-xml-selector="body">[[...]]</template>
    <template data-xml-selector="ce:title">\title{[[.]]} % ID: [[@id]]</template>
    <template data-xml-selector="p">\par [[@id]]: [[...]]</template>
    <template data-xml-selector="ce:italic">\textit{[[.]]}</template>
</templates>
```

### 2. Run the transformation

```bash
# Using Node.js directly
node src/cli.js document.xml template.xml output.tex

# Or if globally installed
transform-xml document.xml template.xml output.tex

# With performance monitoring
node src/cli.js document.xml template.xml output.tex --perf

## Template System

The transformation is controlled by a template file containing XML/HTML rules. All transformation rules must be inside a single `<templates>` root element.

### Template Types

#### 1. Basic Template: `<template>`

The primary template type that matches XML elements and defines their output.

**Required Attribute**: `data-xml-selector` - CSS-like selector to match XML elements

```xml
<!-- Transform all <p> elements -->
<template data-xml-selector="p">\par [[...]]</template>

<!-- Transform <title> elements with specific attributes -->
<template data-xml-selector="ce:title">\title{[[.]]}</template>
```

#### 2. Null Template: `<null-template>`

Matches elements but produces no output - useful for ignoring unwanted XML sections.

```xml
<!-- Ignore all metadata elements -->
<null-template data-xml-selector="metadata"/>

<!-- Skip processing instructions -->
<null-template data-xml-selector="processing-instruction"/>
```

#### 3. Processing Instruction Template: `<pi-template>`

Handles XML Processing Instructions like `<?tex-break?>` or `<?page-break?>`.

**Required Attribute**: `target` - The PI target name
**Optional Attribute**: `match` - Additional matching criteria

```xml
<!-- Handle <?tex-kern amount="5pt"?> -->
<pi-template target="tex-kern">\kern [[@amount]]</pi-template>

<!-- More specific matching -->
<pi-template target="spacing" match="type='vertical'">\vspace{[[@amount]]}</pi-template>
```

#### 4. Unprocessed Template: `<unprocessed-template>`

Defines fallback output for XML elements that don't match any other template.

```xml
<unprocessed-template>
    \fbox{UNHANDLED: [[@tagName]] - [[.]]}
</unprocessed-template>
```

### CSS Selector Support

The engine supports a subset of CSS selectors for matching XML elements:

| Selector Type | Example | Description |
|---------------|---------|-------------|
| **Element** | `p` | Matches all `<p>` elements |
| **Universal** | `*` | Matches all elements |
| **Attribute (exists)** | `[label]` | Elements with a `label` attribute |
| **Attribute (value)** | `[type="note"]` | Elements where `type="note"` |
| **Descendant** | `article p` | `<p>` elements anywhere inside `<article>` |
| **Child** | `head > title` | `<title>` elements that are direct children of `<head>` |
| **Namespace** | `ce:title` | Elements with namespace prefix |
| **Complex** | `section[id] > p` | Direct `<p>` children of `<section>` elements with `id` |

**Selector Specificity**: When multiple templates match the same element, CSS specificity rules determine which template to use:
- Attribute selectors have higher specificity than element selectors
- More specific selectors (e.g., `div[class="warning"]`) override less specific ones (e.g., `div`)
- Child combinators (`>`) are more specific than descendant combinators (space)

## Placeholder System

Placeholders are special commands inside templates that extract data from XML elements. All placeholders use `[[...]]` delimiters.

### Core Placeholders

| Placeholder | Description | Example Usage |
|-------------|-------------|---------------|
| `[[...]]` | **Delegate** - Process all child nodes | `<template data-xml-selector="body">[[...]]</template>` |
| `[[.]]` | **Text Content** - Extract text content only | `<template data-xml-selector="title">\title{[[.]]}</template>` |
| `[[@attr]]` | **Attribute** - Extract attribute value | `<template data-xml-selector="p">\paragraph{[[@id]]}</template>` |
| `[[@tagName]]` | **Tag Name** - Extract element tag name | `\command{[[@tagName]]}{[[.]]}` |

### Advanced Placeholders

| Placeholder | Description | Context |
|-------------|-------------|---------|
| `[[@target]]` | PI target name | Processing Instructions only |
| `[[@data]]` | PI data content | Processing Instructions only |
| `[[selector:...]]` | **Scoped** - Apply to selected child elements | `[[ce:title:.]]` |

### Filters

Placeholders support filter pipelines using the `|` operator:

| Filter | Description | Example |
|--------|-------------|----------|
| `raw` | Skip TeX escaping | `[[@id \| raw]]` |
| Custom filters | User-defined transformations | `[[. \| uppercase]]` |

### Practical Examples

```xml
<!-- XML Input -->
<section id="intro" type="chapter">
    <title>Introduction</title>
    <p>Welcome to the guide.</p>
    <?page-break type="soft"?>
</section>

<!-- Template -->
<templates>
    <template data-xml-selector="section">\section{[[@id | raw]]}
\label{sec:[[@id]]}
[[...]]
    </template>

    <template data-xml-selector="title">\subsection{[[.]]}</template>

    <template data-xml-selector="p">[[.]]\par</template>

    <pi-template target="page-break">\newpage</pi-template>
</templates>

<!-- Output -->
\section{intro}
\label{sec:intro}
\subsection{Introduction}
Welcome to the guide.\par
\newpage
```

## Advanced Features

### Template Composition

Use `<apply-template>` and `<apply-children>` for modular template design:

```xml
<template data-xml-selector="article" xml:space="preserve">
\documentclass[12pt]{article}
\begin{document}
    <apply-template data-xml-selector="head"/>
    <apply-template data-xml-selector="body"/>
\end{document}
</template>
```

### Whitespace Control

By default, templates use smart whitespace trimming. Use `xml:space="preserve"` to maintain exact formatting:

```xml
<template data-xml-selector="code" xml:space="preserve">
\begin{verbatim}
[[.]]
\end{verbatim}
</template>
```

### TeX Character Escaping

The engine automatically escapes TeX special characters:
- `&` → `\&`
- `%` → `\%`
- `$` → `\$`
- `#` → `\#`
- `_` → `\_`
- `{` → `\{`
- `}` → `\}`
- `\` → `\textbackslash{}`
- `^` → `\textasciicircum{}`
- `~` → `\textasciitilde{}`

Use the `| raw` filter to skip escaping when needed:

```xml
<template data-xml-selector="math">$[[@formula | raw]]$</template>
```

## CLI Reference

### Basic Usage

```bash
node src/cli.js <xml-file> <template-file> [output-file] [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--perf` | Display performance metrics (memory, CPU usage) |
| `--run-test` | Run built-in test suite |

### Examples

```bash
# Basic transformation
node src/cli.js template/example.xml template/main.tex.xml output.tex

# Output to stdout
node src/cli.js template/example.xml template/main.tex.xml

# With performance monitoring
node src/cli.js template/example.xml template/main.tex.xml output.tex --perf

### 3. Compile TeX output to PDF

Once you have a `.tex` file, use the bundled LuaLaTeX helper to generate a PDF:

```bash
# Convert a TeX file to PDF in the same directory
node src/tex-to-pdf.js output.tex

# Place the PDF in a specific directory or with a custom filename
node src/tex-to-pdf.js output.tex dist/
node src/tex-to-pdf.js output.tex dist/final.pdf

# The same command via npm (arguments follow the double-dash)
npm run tex:pdf -- output.tex
```

By default the helper also emits a geometry JSON file alongside the PDF (e.g., `output-geometry.json`) that captures per-element quads for paragraphs and headings. Each element includes:
- quads: an array of line-level quads (one per rendered line)
- paragraphQuad: a single quad that bounds the entire element (paragraph/heading) as one rectangle

Paragraph grouping modes:
- default: legacy behavior (more tolerant) and faster
- strict: tighter grouping, adds a dynamic gap guard and uses PDF tag MCIDs when available to avoid merging adjacent paragraphs

Switch modes via CLI with `--geometry-grouping default|strict`, or programmatically with `extractPdfGeometry(pdfPath, { groupingMode: 'strict' })`.

IDs in this JSON mirror the original XML/TeX identifiers (for example the value passed to `\paraid{...}` or `\section`), so downstream consumers can align layout geometry with source content. Override the destination or disable this behaviour entirely:

```bash
# Customise the geometry JSON output location
node src/tex-to-pdf.js output.tex --geometry-json build/pdf-quads.json

# Use stricter paragraph grouping to reduce merges between adjacent paragraphs
node src/tex-to-pdf.js output.tex --geometry-grouping strict

# Skip geometry extraction if you only need the PDF
node src/tex-to-pdf.js output.tex --no-geometry
```

> **Requirements:** LuaLaTeX must be available on your system (e.g., via TeX Live or MiKTeX). The script uses `lualatex -interaction=nonstopmode -halt-on-error` under the hood and reads the compiled PDF to build the geometry JSON.

# Run tests
node src/cli.js --run-test
```

## Library Usage

Use the transformation engine programmatically:

```javascript
const { transform } = require('./src/engine.js');

async function example() {
    const xmlString = `<article><title>Hello</title></article>`;
    const templateString = `
        <templates>
            <template data-xml-selector="article">[[...]]</template>
            <template data-xml-selector="title">\\title{[[.]]}</template>
        </templates>
    `;

    const result = await transform(xmlString, templateString);

    console.log('Output:', result.output);
    console.log('Unprocessed nodes:', result.report.unprocessedNodes.length);
    console.log('Memory used:', result.performance.memoryUsage.heapUsed, 'MB');
}
```

### Custom Processors

```javascript
const customProcessors = {
    filters: {
        uppercase: (text) => text.toUpperCase(),
        prefix: (text, node, context) => `PREFIX: ${text}`
    }
};

const context = {
    engine: {
        escapeFn: (text) => text.replace(/&/g, '\\&') // Custom escaping
    }
};

const result = await transform(xmlString, templateString, customProcessors, context);
```

## Testing

### Built-in Tests

Run the internal test suite:

```bash
node src/cli.js --run-test
```

### Manual Testing

Test with the provided example template:

```bash
# Create a test XML file
echo '<?xml version="1.0"?>
<article>
    <head><ce:title id="t1">Sample Title</ce:title></head>
    <body><p id="p1">Test paragraph</p></body>
</article>' > test.xml

# Run transformation
node src/cli.js test.xml template/main.tex.xml output.tex
```

### Unit Testing

Run the TeX engine-specific tests:

```bash
node src/test-tex-engine.js
```

## Project Structure

```
xml2tex/
├── src/
│   ├── cli.js              # Command-line interface
│   ├── engine.js           # Core transformation engine
│   └── test-tex-engine.js  # Unit tests
├── template/
│   ├── main.tex.xml        # Example template
│   └── document.tex.xml    # Rich document template for template/document.xml
├── package.json            # Project configuration
├── README.md              # This file
└── .gitignore            # Git ignore rules
```

## Dependencies

- **nanoid**: Unique ID generation for XML elements
- **peggy**: PEG parser generator for CSS selectors and placeholders
- **xmldom**: XML parsing and manipulation

## Performance

The engine includes built-in performance monitoring:

- Memory usage tracking (heap allocation)
- CPU usage measurement (user/system time)
- Processing time measurement
- Unprocessed node reporting for optimization

Use the `--perf` flag to display detailed metrics:

```bash
node src/cli.js document.xml template.xml output.tex --perf
```

## Troubleshooting

### Common Issues

1. **"Unprocessed nodes" warnings**: Add templates for missing XML elements or use `<null-template>` to ignore them

2. **Template not matching**: Check CSS selector syntax and XML namespace prefixes

3. **TeX compilation errors**: Verify that special characters are properly escaped or use the `| raw` filter appropriately

4. **Performance issues**: Use performance monitoring to identify bottlenecks in large documents

### Debug Mode

The engine reports unprocessed nodes by default. To get detailed information:

```javascript
const result = await transform(xmlString, templateString);
console.log('Unprocessed nodes:', result.report.unprocessedNodes);
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Make changes and add tests
4. Run the test suite: `node src/cli.js --run-test`
5. Commit changes: `git commit -am 'Add new feature'`
6. Push to branch: `git push origin feature/new-feature`
7. Submit a Pull Request

### Development Setup

```bash
# Clone the repository
git clone <repository-url>
cd xml2tex

# Install dependencies
npm install

# Run tests
node src/cli.js --run-test
node src/test-tex-engine.js

# Test CLI
node src/cli.js --help
```

## License

ISC License - see package.json for details.

## Changelog

### v1.0.0
- Initial release
- Template-driven XML to TeX transformation
- CSS selector support for element matching
- Processing instruction handling
- Automatic TeX character escaping
- Performance monitoring
- Comprehensive placeholder system
