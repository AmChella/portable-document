#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { performance } = require('perf_hooks');
const { transform } = require('./engine.js');

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--run-test')) {
        await _runInternalTests();
        return;
    }

    const perfFlag = args.includes('--perf');
    const fileArgs = args.filter(arg => !arg.startsWith('--'));

    if (fileArgs.length < 2) {
        console.error('Usage: node cli.js <xml-file> <template-file> [output-file] [--perf]');
        console.error('   or: node cli.js --run-test');
        process.exit(1);
    }
    
    const [xmlFilePath, templateFilePath, outputFilePath] = fileArgs;

    if (!fs.existsSync(xmlFilePath)) {
        console.error(`Error: XML file not found at ${xmlFilePath}`);
        process.exit(1);
    }
    if (!fs.existsSync(templateFilePath)) {
        console.error(`Error: Template file not found at ${templateFilePath}`);
        process.exit(1);
    }

    const xmlString = fs.readFileSync(xmlFilePath, 'utf-8');
    const templateString = fs.readFileSync(templateFilePath, 'utf-8');

    try {
        const startTime = performance.now();
        const { output, report, performance: perfData } = await transform(xmlString, templateString);
        const endTime = performance.now();
        
        const duration = (endTime - startTime).toFixed(2);

        if (outputFilePath) {
            fs.writeFileSync(outputFilePath, output);
            console.log(`Output successfully generated at: ${outputFilePath}`);
        } else {
            console.log(output);
        }

        if (perfFlag) {
            console.log('\n--- Performance Metrics ---');
            console.log(`Transformation Time: ${duration} ms`);
            console.log(`Memory Usage (Heap): ${perfData.memoryUsage.heapUsed.toFixed(2)} MB`);
            console.log(`CPU Usage (User): ${perfData.cpuUsage.user.toFixed(2)} ms`);
            console.log(`CPU Usage (System): ${perfData.cpuUsage.system.toFixed(2)} ms`);
            console.log('-------------------------');
        }

        if (report.unprocessedNodes.length > 0) {
            console.warn(`\nContent Validation Report: ${report.unprocessedNodes.length} unprocessed nodes found.`);
            report.unprocessedNodes.slice(0, 10).forEach(node => {
                console.warn(`  - Tag: <${node.tagName}>, Path: ${node.path}`);
            });
            if (report.unprocessedNodes.length > 10) {
                console.warn(`  ... and ${report.unprocessedNodes.length - 10} more.`);
            }
        }

    } catch (error) {
        console.error('\nAn error occurred during transformation:');
        console.error(error);
        process.exit(1);
    }
}


// --- Internal Test Suite ---
async function _runInternalTests() {
    console.log('--- Running XML Transformation Engine Internal Tests ---');
    let allTestsPassed = true;

    // Test Case 1: Mixed placeholders `[[...]]` and `[[@id]]`
    const test1_xml = `<article><head><ce:title id="t0010">Title Text</ce:title></head></article>`;
    const test1_template = `<templates>
            <template data-xml-selector="article">[[...]]</template>
            <template data-xml-selector="head">[[...]]</template>
            <template data-xml-selector="ce:title">\\title{[[...]]}{[[@id]]}</template>
        </templates>`;
    const test1_expected = '\\title{Title Text}{t0010}';
    
    try {
        const result1 = await transform(test1_xml, test1_template);
        assert.strictEqual(result1.output.trim(), test1_expected, 'Test Case 1 Failed: Mixed placeholders');
        console.log('✅ Test Case 1 Passed: Mixed placeholders `[[...]]` and `[[@id]]`');
    } catch (e) {
        console.error(`❌ Test Case 1 Failed: ${e.message}`);
        allTestsPassed = false;
    }

    // Test Case 2: Unprocessed template fallback
    const test2_xml = `<article><abc>test</abc></article>`;
    const test2_template = `<templates><template data-xml-selector="article">[[...]]</template></templates>`;
    const test2_expected = `\\unhandledtag{abc}{test}`;

    try {
        const result2 = await transform(test2_xml, test2_template);
        assert.strictEqual(result2.output.trim(), test2_expected, 'Test Case 2 Failed: Unprocessed template');
        console.log('✅ Test Case 2 Passed: Unprocessed template fallback');
    } catch (e) {
        console.error(`❌ Test Case 2 Failed: ${e.message}`);
        allTestsPassed = false;
    }
    
    console.log('--- All tests completed ---');
    process.exit(allTestsPassed ? 0 : 1);
}

if (require.main === module) {
    main();
}

