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
                    const safeSpToPt = (value) => {
                        if (value === undefined || value === null || value === '') return null;
                        const num = Number(value);
                        return Number.isFinite(num) ? spToPt(num) : null;
                    };
                    const parsePt = (s) => {
                        if (s === undefined || s === null || s === '') return null;
                        const parsed = parseFloat(String(s).replace(/pt$/, ''));
                        return Number.isFinite(parsed) ? parsed : null;
                    };
                    const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
                    const DEFAULT_LINE_HEIGHT = 14;

                    const marksByPage = new Map();
                    const elementMap = new Map();

                    const getBaseRole = (role) => {
                        if (role.startsWith('FIG')) return 'FIG';
                        if (role.startsWith('TABLE')) return 'TABLE';
                        if (role.startsWith('P')) return 'P';
                        return role;
                    };

                    const getRecord = (id, baseRole) => {
                        let rec = elementMap.get(id);
                        if (!rec) {
                            rec = { id, role: baseRole, starts: [], ends: [] };
                            elementMap.set(id, rec);
                        }
                        return rec;
                    };

                    for (const rawMark of marks) {
                        if (!rawMark || typeof rawMark !== 'object') continue;
                        const role = String(rawMark.role || '');
                        if (!/^(FIG|TABLE|P)-(start|end)$/.test(role)) {
                            continue;
                        }
                        const baseRole = getBaseRole(role);
                        const type = role.endsWith('start') ? 'start' : 'end';
                        const pageIndex = (rawMark.page || 1) - 1;
                        const pwPt = parsePt(rawMark.pw);
                        const phPt = parsePt(rawMark.ph);
                        const xPt = safeSpToPt(rawMark.xsp);
                        const yPt = safeSpToPt(rawMark.ysp);
                        const columnWidthPt = safeSpToPt(rawMark.cwsp);
                        const textWidthPt = safeSpToPt(rawMark.twsp);
                        const columnSepPt = safeSpToPt(rawMark.colsep);

                        const mark = {
                            id: rawMark.id,
                            role: baseRole,
                            type,
                            pageIndex,
                            pageWidthPt: pwPt,
                            pageHeightPt: phPt,
                            xPt,
                            yPt,
                            rawYSp: Number(rawMark.ysp),
                            columnWidthPt,
                            textWidthPt,
                            columnSepPt
                        };

                        if (!marksByPage.has(pageIndex)) marksByPage.set(pageIndex, []);
                        marksByPage.get(pageIndex).push(mark);

                        const record = getRecord(mark.id, baseRole);
                        if (type === 'start') {
                            record.starts.push(mark);
                        } else {
                            record.ends.push(mark);
                        }
                    }

                    if (!marksByPage.size) {
                        throw new Error('No usable TeX position marks were found.');
                    }

                    const clusterColumnLefts = (values) => {
                        const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
                        const clusters = [];
                        const tolerance = 5; // pts
                        for (const value of sorted) {
                            let cluster = null;
                            for (const existing of clusters) {
                                if (Math.abs(existing.value - value) <= tolerance) {
                                    cluster = existing;
                                    break;
                                }
                            }
                            if (!cluster) {
                                clusters.push({ value, count: 1 });
                            } else {
                                cluster.value = (cluster.value * cluster.count + value) / (cluster.count + 1);
                                cluster.count += 1;
                            }
                        }
                        return clusters.map((c) => c.value).sort((a, b) => a - b);
                    };

                    const assignColumnIndex = (xPt, columnLefts) => {
                        if (!Number.isFinite(xPt) || !columnLefts.length) return null;
                        let bestIndex = 0;
                        let bestDistance = Infinity;
                        for (let i = 0; i < columnLefts.length; i += 1) {
                            const distance = Math.abs(columnLefts[i] - xPt);
                            if (distance < bestDistance) {
                                bestDistance = distance;
                                bestIndex = i;
                            }
                        }
                        return bestIndex;
                    };

                    const pageMetaMap = new Map();

                    for (const [pageIndex, markList] of marksByPage.entries()) {
                        if (!markList.length) continue;
                        const pageHeight = markList.find((m) => isFiniteNumber(m.pageHeightPt))?.pageHeightPt || null;
                        const pageWidth = markList.find((m) => isFiniteNumber(m.pageWidthPt))?.pageWidthPt || null;
                        for (const mark of markList) {
                            if (isFiniteNumber(mark.yPt) && isFiniteNumber(pageHeight)) {
                                mark.topCoord = pageHeight - mark.yPt;
                            } else {
                                mark.topCoord = null;
                            }
                        }

                        let xValues = markList
                            .filter((m) => m.type === 'start' && Number.isFinite(m.xPt))
                            .map((m) => m.xPt);
                        if (!xValues.length) {
                            xValues = markList.map((m) => m.xPt).filter((v) => Number.isFinite(v));
                        }
                        let columnLefts = clusterColumnLefts(xValues);
                        if (!columnLefts.length && Number.isFinite(pageWidth)) {
                            columnLefts = [72];
                        }

                        const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
                        const columnWidthAvg = avg(markList.map((m) => m.columnWidthPt).filter(isFiniteNumber));
                        const textWidthAvg = avg(markList.map((m) => m.textWidthPt).filter(isFiniteNumber));
                        const columnSepAvg = avg(markList.map((m) => m.columnSepPt).filter(isFiniteNumber));

                        markList.forEach((mark) => {
                            mark.columnIndex = assignColumnIndex(mark.xPt, columnLefts);
                        });

                        const columns = columnLefts.map((left, idx) => ({
                            index: idx,
                            left,
                            width: columnWidthAvg,
                            events: []
                        }));

                        for (const mark of markList) {
                            if (mark.columnIndex !== null && columns[mark.columnIndex]) {
                                columns[mark.columnIndex].events.push(mark);
                            }
                        }

                        for (let c = 0; c < columns.length; c += 1) {
                            const column = columns[c];
                            column.events.sort((a, b) => {
                                const ay = Number.isFinite(a.rawYSp) ? a.rawYSp : -Infinity;
                                const by = Number.isFinite(b.rawYSp) ? b.rawYSp : -Infinity;
                                return by - ay;
                            });
                            const topValues = column.events.map((ev) => ev.topCoord).filter(isFiniteNumber);
                            column.columnTop = topValues.length ? Math.min(...topValues) : 0;
                            const topMax = topValues.length ? Math.max(...topValues) : (isFiniteNumber(pageHeight) ? pageHeight - 72 : DEFAULT_LINE_HEIGHT * 4);
                            const bottomBase = isFiniteNumber(pageHeight) ? Math.min(pageHeight, topMax + DEFAULT_LINE_HEIGHT) : topMax + DEFAULT_LINE_HEIGHT;
                            column.columnBottom = bottomBase;

                            if (!isFiniteNumber(column.width)) {
                                if (columns.length > 1 && c < columns.length - 1) {
                                    const gap = columns[c + 1].left - column.left;
                                    column.width = columnSepAvg ? Math.max(10, gap - columnSepAvg) : gap - 10;
                                } else if (isFiniteNumber(textWidthAvg) && columns.length) {
                                    const totalSep = columnSepAvg ? columnSepAvg * (columns.length - 1) : 0;
                                    column.width = (textWidthAvg - totalSep) / Math.max(1, columns.length);
                                } else if (isFiniteNumber(columnWidthAvg)) {
                                    column.width = columnWidthAvg;
                                } else if (isFiniteNumber(pageWidth)) {
                                    column.width = pageWidth - 144; // assume 1in margins
                                } else {
                                    column.width = 200;
                                }
                            }

                            for (let i = 0; i < column.events.length; i += 1) {
                                const event = column.events[i];
                                const nextEvent = column.events[i + 1];
                                let nextTop = column.columnBottom;
                                if (nextEvent && isFiniteNumber(nextEvent.topCoord)) {
                                    nextTop = nextEvent.topCoord;
                                }
                                if (!isFiniteNumber(nextTop)) {
                                    nextTop = isFiniteNumber(event.topCoord) ? event.topCoord + DEFAULT_LINE_HEIGHT : DEFAULT_LINE_HEIGHT;
                                }
                                if (isFiniteNumber(event.topCoord) && nextTop <= event.topCoord) {
                                    nextTop = event.topCoord + DEFAULT_LINE_HEIGHT;
                                }
                                event.nextTop = nextTop;
                            }
                        }

                        pageMetaMap.set(pageIndex, {
                            pageHeight,
                            pageWidth,
                            columns,
                            columnSep: columnSepAvg,
                            columnWidth: columnWidthAvg,
                            textWidth: textWidthAvg
                        });
                    }

                    const segmentFromEvent = (event) => {
                        if (!event) return null;
                        const pageMeta = pageMetaMap.get(event.pageIndex);
                        if (!pageMeta) return null;
                        const column = (event.columnIndex !== null) ? pageMeta.columns[event.columnIndex] : null;
                        if (!column) return null;
                        const left = column.left;
                        const width = column.width;
                        if (!isFiniteNumber(left) || !isFiniteNumber(width)) return null;
                        const right = left + width;
                        const top = isFiniteNumber(event.topCoord) ? event.topCoord : column.columnTop;
                        let bottom = isFiniteNumber(event.nextTop) ? event.nextTop : column.columnBottom;
                        if (!isFiniteNumber(bottom)) {
                            bottom = top + DEFAULT_LINE_HEIGHT;
                        }
                        if (bottom <= top) bottom = top + DEFAULT_LINE_HEIGHT;
                        const quad = [left, top, right, top, right, bottom, left, bottom];
                        return {
                            pageIndex: event.pageIndex,
                            columnIndex: event.columnIndex,
                            left,
                            right,
                            width,
                            top,
                            bottom,
                            quad
                        };
                    };

                    const mergeQuads = (quads) => {
                        if (!quads.length) return null;
                        let left = Infinity;
                        let right = -Infinity;
                        let top = Infinity;
                        let bottom = -Infinity;
                        for (const quad of quads) {
                            if (!Array.isArray(quad) || quad.length !== 8) continue;
                            left = Math.min(left, quad[0], quad[6]);
                            right = Math.max(right, quad[2], quad[4]);
                            top = Math.min(top, quad[1], quad[3]);
                            bottom = Math.max(bottom, quad[5], quad[7]);
                        }
                        if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) {
                            return null;
                        }
                        return [left, top, right, top, right, bottom, left, bottom];
                    };

                    const pagesMap = new Map();

                    for (const record of elementMap.values()) {
                        const segmentsByPage = new Map();
                        const coveredColumns = new Map();

                        for (const startEvent of record.starts) {
                            const seg = segmentFromEvent(startEvent);
                            if (!seg) continue;
                            if (!segmentsByPage.has(seg.pageIndex)) segmentsByPage.set(seg.pageIndex, []);
                            segmentsByPage.get(seg.pageIndex).push(seg);
                            if (!coveredColumns.has(seg.pageIndex)) coveredColumns.set(seg.pageIndex, new Set());
                            coveredColumns.get(seg.pageIndex).add(seg.columnIndex);
                        }

                        for (const endEvent of record.ends) {
                            const covered = coveredColumns.get(endEvent.pageIndex);
                            if (covered && covered.has(endEvent.columnIndex)) continue;
                            const seg = segmentFromEvent(endEvent);
                            if (!seg) continue;
                            if (!segmentsByPage.has(seg.pageIndex)) segmentsByPage.set(seg.pageIndex, []);
                            segmentsByPage.get(seg.pageIndex).push(seg);
                        }

                        for (const [pageIndex, segments] of segmentsByPage.entries()) {
                            if (!segments.length) continue;
                            const quads = segments.map((seg) => seg.quad).filter(Boolean);
                            if (!quads.length) continue;
                            const paragraphQuad = mergeQuads(quads);
                            const element = {
                                id: record.id,
                                role: record.role,
                                lang: flags.language,
                                quads,
                                columnSegments: segments.map((seg) => ({
                                    columnIndex: seg.columnIndex,
                                    columnLeftPt: Number(seg.left.toFixed(4)),
                                    columnRightPt: Number(seg.right.toFixed(4)),
                                    columnWidthPt: Number(seg.width.toFixed(4)),
                                    topPt: Number(seg.top.toFixed(4)),
                                    bottomPt: Number(seg.bottom.toFixed(4))
                                }))
                            };
                            if (paragraphQuad) {
                                element.paragraphQuad = paragraphQuad;
                            }
                            const primarySegment = segments[0];
                            if (primarySegment) {
                                element.columnIndex = primarySegment.columnIndex;
                                element.columnLeftPt = Number(primarySegment.left.toFixed(4));
                                element.columnRightPt = Number(primarySegment.right.toFixed(4));
                                element.columnWidthPt = Number(primarySegment.width.toFixed(4));
                            }
                            const pageMeta = pageMetaMap.get(pageIndex);
                            if (pageMeta && pageMeta.columns && pageMeta.columns.length > 1) {
                                element.twoColumnLayout = true;
                                if (isFiniteNumber(pageMeta.columnSep)) {
                                    element.columnSepPt = Number(pageMeta.columnSep.toFixed(4));
                                }
                                if (isFiniteNumber(pageMeta.textWidth)) {
                                    element.textWidthPt = Number(pageMeta.textWidth.toFixed(4));
                                }
                            }
                            if (!pagesMap.has(pageIndex)) pagesMap.set(pageIndex, []);
                            pagesMap.get(pageIndex).push(element);
                        }
                    }

                    if (!pagesMap.size) {
                        throw new Error('Unable to derive geometry segments from TeX marks.');
                    }

                    const pageIndices = Array.from(pagesMap.keys()).sort((a, b) => a - b);
                    const pages = pageIndices.map((idx) => ({ index: idx, elements: pagesMap.get(idx) }));
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
