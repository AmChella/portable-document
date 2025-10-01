#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HELP_FLAGS = new Set(['--help', '-h']);

function extractElementIdQueues(texSource) {
    if (!texSource || typeof texSource !== 'string') {
        return null;
    }

    const queues = {};
    const push = (role, value) => {
        if (!value) return;
        if (!queues[role]) {
            queues[role] = [];
        }
        queues[role].push(value.trim());
    };

    const titleRegex = /\\title\{[^}]*\}\{([^}]*)\}/g;
    let match;
    while ((match = titleRegex.exec(texSource)) !== null) {
        push('Title', match[1]);
    }

    const paraRegex = /\\paraid\{([^}]*)\}/g;
    while ((match = paraRegex.exec(texSource)) !== null) {
        push('P', match[1]);
    }

    const sectionRegex = /\\section\{[^}]*\}\s*\\label\{([^}]*)\}/g;
    while ((match = sectionRegex.exec(texSource)) !== null) {
        push('H1', match[1]);
    }

    // Hypertarget anchors for figures and tables (start and end)
    const hypertargetRegex = /\\hypertarget\{([^}]*)\}\{\}/g;
    while ((match = hypertargetRegex.exec(texSource)) !== null) {
        const id = match[1];
        if (id.startsWith('fig-')) {
            // only collect the base figure id (skip -end variant)
            if (!id.endsWith('-end')) push('FIG', id);
        } else if (id.startsWith('tbl-')) {
            if (!id.endsWith('-end')) push('TABLE', id);
        }
    }

    return Object.keys(queues).length ? queues : null;
}

function printUsage() {
    console.log(`Usage: node src/tex-to-pdf.js <input.tex> [output-directory|output.pdf] [options]\n` +
`Options:\n` +
`  --keep-aux        Preserve auxiliary files (.aux, .log, .toc, .out, .synctex.gz)\n` +
`  --shell-escape    Enable LaTeX shell escape (passes --shell-escape to lualatex)\n` +
`  --geometry-json <path>  Emit layout geometry JSON to the provided path\n` +
`                         (defaults to <jobname>-geometry.json next to the PDF)\n` +
`  --geometry-grouping <mode>  Set grouping mode: 'default' (current) or 'strict'\n` +
`  --no-geometry     Skip geometry JSON generation\n` +
`  --lang <code>     Set the language code for geometry metadata (default: en)\n` +
`  -h, --help        Show this help text\n` +
`Examples:\n` +
`  node src/tex-to-pdf.js output.tex\n` +
`  node src/tex-to-pdf.js output.tex dist/\n` +
`  node src/tex-to-pdf.js output.tex dist/final.pdf --keep-aux\n` +
`  node src/tex-to-pdf.js output.tex --geometry-json build/layout.json`);
}

function ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

async function runLatex(args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn('lualatex', args, { cwd, stdio: 'inherit' });

        child.on('error', (error) => {
            if (error.code === 'ENOENT') {
                reject(new Error('lualatex command not found. Please ensure LuaLaTeX is installed and available in PATH.'));
            } else {
                reject(error);
            }
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`LuaLaTeX exited with code ${code}.`));
            }
        });
    });
}

function sanitizeArgs(rawArgs) {
    const fileArgs = [];
    const flags = {
        keepAux: false,
        shellEscape: false,
        help: false,
        emitGeometry: true,
        geometryPath: null,
        language: 'en',
        geometryGrouping: null // 'strict' or null
    };

    for (let i = 0; i < rawArgs.length; i += 1) {
        const arg = rawArgs[i];

        if (HELP_FLAGS.has(arg)) {
            flags.help = true;
            continue;
        }
        if (arg === '--keep-aux') {
            flags.keepAux = true;
            continue;
        }
        if (arg === '--shell-escape') {
            flags.shellEscape = true;
            continue;
        }
        if (arg === '--no-geometry') {
            flags.emitGeometry = false;
            continue;
        }
        if (arg === '--geometry-json') {
            const next = rawArgs[i + 1];
            if (!next || next.startsWith('--')) {
                console.error('Error: --geometry-json requires a file path.');
                process.exit(1);
            }
            flags.geometryPath = next;
            i += 1;
            continue;
        }
        if (arg === '--geometry-grouping') {
            const next = rawArgs[i + 1];
            if (!next || next.startsWith('--') || !['default','strict'].includes(next)) {
                console.error("Error: --geometry-grouping requires 'default' or 'strict'.");
                process.exit(1);
            }
            flags.geometryGrouping = next;
            i += 1;
            continue;
        }
        if (arg.startsWith('--geometry-json=')) {
            const value = arg.split('=').slice(1).join('=');
            if (!value) {
                console.error('Error: --geometry-json requires a file path.');
                process.exit(1);
            }
            flags.geometryPath = value;
            continue;
        }
        if (arg.startsWith('--geometry-grouping=')) {
            const value = arg.split('=').slice(1).join('=');
            if (!['default','strict'].includes(value)) {
                console.error("Error: --geometry-grouping must be 'default' or 'strict'.");
                process.exit(1);
            }
            flags.geometryGrouping = value;
            continue;
        }
        if (arg === '--lang') {
            const next = rawArgs[i + 1];
            if (!next || next.startsWith('--')) {
                console.error('Error: --lang requires a language code (e.g., en).');
                process.exit(1);
            }
            flags.language = next;
            i += 1;
            continue;
        }
        if (arg.startsWith('--lang=')) {
            const value = arg.split('=').slice(1).join('=');
            if (!value) {
                console.error('Error: --lang requires a language code (e.g., en).');
                process.exit(1);
            }
            flags.language = value;
            continue;
        }

        fileArgs.push(arg);
    }

    return { fileArgs, flags };
}

function resolveOutputPaths(texPath, targetPath) {
    const texDir = path.dirname(texPath);
    const texBase = path.basename(texPath, path.extname(texPath));

    if (!targetPath) {
        return {
            workingDir: texDir,
            outputDir: texDir,
            jobName: texBase
        };
    }

    const resolvedTarget = path.resolve(targetPath);
    const targetExt = path.extname(resolvedTarget).toLowerCase();

    if (targetExt === '.pdf') {
        ensureDirectory(path.dirname(resolvedTarget));
        return {
            workingDir: texDir,
            outputDir: path.dirname(resolvedTarget),
            jobName: path.basename(resolvedTarget, targetExt)
        };
    }

    // Treat as directory target
    ensureDirectory(resolvedTarget);
    return {
        workingDir: texDir,
        outputDir: resolvedTarget,
        jobName: texBase
    };
}

function cleanAuxiliaryFiles(outputDir, jobName) {
    const extensions = ['.aux', '.log', '.out', '.toc'];
    const additionalFiles = [`${jobName}.synctex.gz`];

    for (const ext of extensions) {
        const filePath = path.join(outputDir, `${jobName}${ext}`);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (err) { /* ignore */ }
        }
    }

    for (const file of additionalFiles) {
        const filePath = path.join(outputDir, file);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (err) { /* ignore */ }
        }
    }
}

async function main() {
    const rawArgs = process.argv.slice(2);
    const { fileArgs, flags } = sanitizeArgs(rawArgs);

    if (flags.help || fileArgs.length === 0) {
        printUsage();
        process.exit(flags.help ? 0 : 1);
    }

    const [texFile, outputTarget] = fileArgs;
    if (!texFile.endsWith('.tex')) {
        console.error('Error: Input file must be a .tex file.');
        process.exit(1);
    }

    const resolvedTexFile = path.resolve(texFile);
    if (!fs.existsSync(resolvedTexFile) || !fs.statSync(resolvedTexFile).isFile()) {
        console.error(`Error: TeX file not found at ${resolvedTexFile}`);
        process.exit(1);
    }

    const { workingDir, outputDir, jobName } = resolveOutputPaths(resolvedTexFile, outputTarget);

        const pdfPath = path.join(outputDir, `${jobName}.pdf`);

        const latexArgs = [
        '-interaction=nonstopmode',
        '-halt-on-error',
        `-output-directory=${outputDir}`,
        `-jobname=${jobName}`,
        path.basename(resolvedTexFile)
    ];

    if (flags.shellEscape) {
        latexArgs.splice(2, 0, '--shell-escape');
    }

    let texSource = null;
    try {
        texSource = fs.readFileSync(resolvedTexFile, 'utf8');
    } catch (readErr) {
        console.error(`Error: Unable to read TeX source at ${resolvedTexFile}`);
        console.error(readErr.message);
        process.exit(1);
    }

    const idQueues = extractElementIdQueues(texSource);

    try {
        const start = Date.now();
        await runLatex(latexArgs, workingDir);
        // If TeX positions NDJSON is produced, rerun once to stabilize positions
        const texPosCandidate = path.join(outputDir, `${jobName}-texpos.ndjson`);
        const texPosCandidateOut = path.join(outputDir, `${jobName}-texpos.ndjson`);
        const texPosCandidateCwd = path.join(workingDir, `${jobName}-texpos.ndjson`);
        if (fs.existsSync(texPosCandidate) || fs.existsSync(texPosCandidateOut) || fs.existsSync(texPosCandidateCwd)) {
            try { await runLatex(latexArgs, workingDir); } catch (_) {}
        }
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);

        if (!fs.existsSync(pdfPath)) {
            throw new Error(`Expected PDF not found at ${pdfPath}`);
        }

        if (flags.emitGeometry) {
            const geometryTarget = flags.geometryPath
                ? path.resolve(flags.geometryPath)
                : path.join(outputDir, `${jobName}-geometry.json`);
            const geometryDir = path.dirname(geometryTarget);
            ensureDirectory(geometryDir);

            // Prefer TeX-produced positions if available; fall back to PDF parsing
            const texPosPathOut = path.join(outputDir, `${jobName}-texpos.ndjson`);
            const texPosPathCwd = path.join(workingDir, `${jobName}-texpos.ndjson`);
            let usedTexPos = false;
            let marks = null;
            if (fs.existsSync(texPosPathOut) || fs.existsSync(texPosPathCwd)) {
                try {
                    const candidate = fs.existsSync(texPosPathOut) ? texPosPathOut : texPosPathCwd;
                    const lines = fs.readFileSync(candidate, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                    if (lines.length > 0) {
                        marks = lines.map(l => JSON.parse(l));
                    } else {
                        marks = null;
                    }
                } catch (e) {
                    marks = null;
                }
            }
            // Fallback to parsing .log for GEOM lines
            if (!marks) {
                const logPath = path.join(outputDir, `${jobName}.log`);
                if (fs.existsSync(logPath)) {
                    const logText = fs.readFileSync(logPath, 'utf8');
                    const geomLines = logText.split(/\r?\n/).filter(l => l.startsWith('GEOM: '));
                    if (geomLines.length) {
                        try {
                            marks = geomLines.map(l => JSON.parse(l.substring(6)));
                        } catch (e) {
                            marks = null;
                        }
                    }
                }
            }
            if (marks) {
                try {
                    const spToPt = (sp) => Number(sp) / 65536;
                    const parsePt = (s) => parseFloat(String(s).replace(/pt$/, ''));
                    const floatsById = new Map();
                    for (const m of marks) {
                        const pageIndex = (m.page || 1) - 1;
                        const xPt = spToPt(Number(m.xsp));
                        const yTopPt = spToPt(Number(m.ysp)); // from top
                        const pwPt = parsePt(m.pw);
                        const phPt = parsePt(m.ph);
                        // Pair start/end for floats and paragraphs on same page
                        if (/^(FIG|TABLE|P)-(start|end)$/.test(m.role)) {
                            const baseRole = m.role.startsWith('FIG') ? 'FIG' : (m.role.startsWith('TABLE') ? 'TABLE' : 'P');
                            const kind = m.role.endsWith('start') ? 'start' : 'end';
                            let rec = floatsById.get(m.id);
                            if (!rec) {
                                rec = { id: m.id, role: baseRole, pageIndex, yStart: null, yEnd: null, pwPt, phPt };
                                floatsById.set(m.id, rec);
                            }
                            if (rec.pageIndex !== pageIndex) continue; // ignore cross-page for now
                            if (kind === 'start') rec.yStart = yTopPt; else rec.yEnd = yTopPt;
                        }
                    }
                    const pagesMap = new Map();
                    const left = 72; // assume 1in margin
                    // right margin: 1in
                    for (const [id, rec] of floatsById.entries()) {
                        if (rec.yStart == null || rec.yEnd == null) continue;
                        const right = rec.pwPt - 72;
                        const top = Math.max(rec.yStart, rec.yEnd);
                        const bottom = Math.min(rec.yStart, rec.yEnd);
                        const yTopPdf = rec.phPt - top;
                        const yBottomPdf = rec.phPt - bottom;
                        const quad = [left, yTopPdf, right, yTopPdf, right, yBottomPdf, left, yBottomPdf];
                        if (!pagesMap.has(rec.pageIndex)) pagesMap.set(rec.pageIndex, []);
                        pagesMap.get(rec.pageIndex).push({ id: rec.id, role: rec.role, lang: flags.language, quads: [quad], paragraphQuad: quad });
                    }
                    const pageIndices = Array.from(pagesMap.keys()).sort((a,b)=>a-b);
                    const pages = pageIndices.map(i => ({ index: i, elements: pagesMap.get(i) }));
                    const crypto = require('crypto');
                    const pdfBuf = fs.readFileSync(pdfPath);
                    const docId = crypto.createHash('sha256').update(pdfBuf).digest('hex');
                    const geometryData = { pdfGeometryV1: { docId, pages } };
                    fs.writeFileSync(geometryTarget, JSON.stringify(geometryData, null, 2));
                    console.log(`Geometry JSON written: ${geometryTarget}`);
                    usedTexPos = true;
                } catch (e) {
                    console.error('Failed to generate geometry from TeX positions; falling back to PDF parsing.');
                    console.error(e.message);
                }
            }

            if (!usedTexPos) {
                try {
                    const { extractPdfGeometry } = require('./pdf-geometry');
                    const geometryOptions = { language: flags.language };
                    if (flags.geometryGrouping) geometryOptions.groupingMode = flags.geometryGrouping;
                    if (idQueues) {
                        geometryOptions.idQueues = idQueues;
                    }
                    const geometryData = await extractPdfGeometry(pdfPath, geometryOptions);
                    fs.writeFileSync(geometryTarget, JSON.stringify(geometryData, null, 2));
                    console.log(`Geometry JSON written: ${geometryTarget}`);
                } catch (geometryError) {
                    console.error('Failed to generate geometry JSON.');
                    console.error(geometryError.message);
                    process.exit(1);
                }
            }
        }

        if (!flags.keepAux) {
            cleanAuxiliaryFiles(outputDir, jobName);
        }

        console.log(`\nPDF generated: ${pdfPath}`);
        console.log(`Compilation time: ${elapsed}s`);
    } catch (error) {
        console.error(`\nFailed to compile ${resolvedTexFile}`);
        console.error(error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
