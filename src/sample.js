const peggy = require('peggy');

/*
 * 🎯 SGF (Smart Game Format) Parser Demo
 * 
 * This script demonstrates how Peggy parsers work, similar to how the main XML2TeX
 * engine uses Peggy for CSS selectors and placeholders. This particular example
 * parses SGF files used for board games like Go.
 * 
 * The original script had syntax errors - this is a fixed, working version.
 * 
 * What this demonstrates:
 * 1. How to define a PEG grammar using Peggy
 * 2. How to parse structured text data
 * 3. How to transform parse results into meaningful output
 * 
 * This relates to xml2tex because:
 * - The main engine uses Peggy to parse CSS selectors
 * - It also uses Peggy to parse template placeholders like [[...]] and [[@attr]]
 * - This shows the same parsing principles in action
 */

console.log('🎯 SGF Parser Demo - Peggy in Action');
console.log('=========================================');
console.log();
console.log('This demonstrates the same Peggy parsing technology');
console.log('used in the main xml2tex engine for:');
console.log('  • CSS selector parsing');
console.log('  • Template placeholder parsing');
console.log('  • Processing instruction parsing');
console.log();

// Simple grammar for basic SGF elements
const grammar = `
  start = "(" nodes:Node+ ")"
  
  Node = ";" properties:Property* {
    return { type: 'node', properties: properties };
  }
  
  Property = name:PropName values:PropValue+ {
    return { name: name, values: values };
  }
  
  PropName = chars:Letter+ { return chars.join(''); }
  Letter = [A-Z]
  
  PropValue = "[" value:$(!"]".)*"]" {
    return value;
  }
`;

// Simple SGF example (without variations to keep it simple)
const sgfData = "(;GM[1]FF[4]SZ[19];B[pd];W[dd];B[pq])";

try {
  console.log('📄 Input SGF:', sgfData);
  
  const parser = peggy.generate(grammar);
  const parseResult = parser.parse(sgfData);
  
  // The parser returns [ "(", [nodes...], ")" ] so we need the middle element
  const nodes = parseResult[1]; // Get the nodes array
  
  console.log();
  console.log('🌳 Successfully parsed', nodes.length, 'nodes:');
  console.log();
  
  nodes.forEach((node, i) => {
    if (i === 0) {
      console.log('📋 Root Node (Game Setup):');
      node.properties.forEach(prop => {
        const descriptions = {
          'GM': 'Game Type (1=Go)',
          'FF': 'File Format Version',
          'SZ': 'Board Size'
        };
        const desc = descriptions[prop.name] || prop.name;
        console.log(`    ${desc}: ${prop.values[0]}`);
      });
    } else {
      console.log(`🎮 Move ${i}:`);
      node.properties.forEach(prop => {
        const player = prop.name === 'B' ? 'Black ⚫' : 'White ⚪';
        console.log(`    ${player} plays at ${prop.values[0]}`);
      });
    }
  });
  
  console.log();
  console.log('✨ This shows the same parsing principles used in xml2tex for:');
  console.log('   - CSS selectors: "div > p[class="highlight"]"');
  console.log('   - Placeholders: "[[...]]" and "[[@attribute]]"');
  console.log('   - Processing instructions: "<?xml-tex spacing="5pt"?>"');
  
} catch (error) {
  console.error('❌ Parsing failed:', error.message);
  console.log('\n🔧 The original script had malformed character classes in the Peggy grammar.');
  console.log('Character classes like [A-Z] need proper escaping in some contexts.');
}
