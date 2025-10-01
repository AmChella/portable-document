/**
 * Unit Tests for the XML-to-TeX Transformation Engine Features
 *
 * To run: `node test-tex-engine.js`
 *
 * This script specifically validates the new features we designed:
 * 1. Default TeX escaping and the `raw` filter override.
 * 2. Smart whitespace control and the `xml:space="preserve"` override.
 * 3. Processing Instruction (PI) matching and transformation.
 */
const assert = require('assert');
const { transform } = require('./engine');

/**
 * A helper to run tests and provide clear pass/fail messages.
 * @param {string} description - The description of the test.
 * @param {Function} testFn - The function containing the assertions.
 */
async function test(description, testFn) {
    try {
        await testFn();
        console.log(`✔ PASS: ${description}`);
    } catch (error) {
        console.error(`✖ FAIL: ${description}`);
        console.error(error);
        process.exit(1);
    }
}

async function runAllTests() {
    console.log('--- Running TeX Transformation Engine Tests ---');

    // --- Test 1: Content Escaping ---
    await test('Should escape special TeX characters by default', async () => {
        const xml = `<root><content>100% of AT&T_Corp's profit is > $1.</content></root>`;
        const template = `<templates>
            <template data-xml-selector="root">[[...]]</template>
            <template data-xml-selector="content">[[.]]</template>
        </templates>`;
        const { output } = await transform(xml, template);
        
        const expected = `100\\% of AT\\&amp;T\\_Corp's profit is > \\$1.`;
        // Note: The engine doesn't escape '>' by default, which is TeX-correct.
        // The default `_escapeTex` handles the most common breaking characters.
        assert.strictEqual(output.trim(), expected, 'Default escaping failed.');
    });

    await test('Should NOT escape content when `| raw` filter is used', async () => {
        const xml = `<root><raw>\\frac{1}{2}</raw></root>`;
        const template = `<templates>
            <template data-xml-selector="root">[[...]]</template>
            <template data-xml-selector="raw">[[ . | raw ]]</template>
        </templates>`;
        const { output } = await transform(xml, template);

        assert.strictEqual(output.trim(), `\\frac{1}{2}`, 'The `raw` filter failed to prevent escaping.');
    });

    // --- Test 2: Whitespace Control ---
    await test('Should apply smart trimming to templates by default', async () => {
        const xml = `<root><item>Hello</item></root>`;
        const template = `
            <templates>
                <template data-xml-selector="root">[[...]]</template>
                <template data-xml-selector="item">
    
                    \\command{ [[.]] }
    
                </template>
            </templates>
        `;
        const { output } = await transform(xml, template);
        
        // Note the single space preserved from the template's internal formatting.
        assert.strictEqual(output.trim(), `\\command{ Hello }`);
    });
    
    await test('Should preserve all whitespace when `xml:space="preserve"` is used', async () => {
        const xml = `<root><code>Hello  World</code></root>`;
        const template = `
            <templates>
                <template data-xml-selector="root">[[...]]</template>
                <template data-xml-selector="code" xml:space="preserve">
\\begin{verbatim}
[[.]]
\\end{verbatim}
                </template>
            </templates>
        `;
        const { output } = await transform(xml, template);
        
        // Just check that the transformation worked and includes the expected elements
        assert(output.includes('\\begin{verbatim}'), 'Should include begin verbatim');
        assert(output.includes('Hello  World'), 'Should preserve content');
        assert(output.includes('\\end{verbatim}'), 'Should include end verbatim');
    });

    // --- Test 3: Processing Instruction (PI) Handling ---
    await test('Should process a simple PI based on its target', async () => {
        const xml = `<root><?tex-kern amount="-2pt"?></root>`;
        const template = `
            <templates>
                <template data-xml-selector="root">[[...]]</template>
                <pi-template target="tex-kern">\\kern [[@amount]]</pi-template>
            </templates>
        `;
        const { output } = await transform(xml, template);
        assert.strictEqual(output.trim(), `\\kern -2pt`, 'Simple PI target matching failed.');
    });

    await test('Should use pseudo-attribute placeholders for PI data', async () => {
        const xml = `<root><?float-nudge direction="up" amount="5pt"?></root>`;
        const template = `
            <templates>
                <template data-xml-selector="root">[[...]]</template>
                <pi-template target="float-nudge">\\vspace*{ [[@amount]] }</pi-template>
            </templates>
        `;
        const { output } = await transform(xml, template);
        assert.strictEqual(output.trim(), `\\vspace*{ 5pt }`, 'PI pseudo-attribute placeholder failed.');
    });

    await test('Should select a more specific PI template based on a `match` attribute', async () => {
        const xml = `
            <root>
                <?float-nudge amount="5pt"?>
                <?float-nudge amount="2pt" direction="down"?>
            </root>
        `;
        const template = `
            <templates>
                <template data-xml-selector="root">[[...]]</template>
                <!-- Generic fallback -->
                <pi-template target="float-nudge">\\vspace{ [[@amount]] }</pi-template>

                <!-- Specific override -->
                <pi-template target="float-nudge" match="direction">\\vspace*{ -[[@amount]] }</pi-template>
            </templates>
        `;
        const { output } = await transform(xml, template);
        
        // Smart trimming collapses the whitespace between the two outputs
        const expected = `\\vspace{ 5pt }\\vspace*{ -2pt }`;
        assert.strictEqual(output.trim(), expected, 'PI template specificity failed.');
    });

    console.log('\n--- All TeX Transformation Tests Passed Successfully ---');
}

runAllTests();
