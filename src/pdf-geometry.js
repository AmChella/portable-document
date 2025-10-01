const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const workerSrcPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrcPath;

const { Util } = pdfjsLib;

function round(num) {
    return Math.round(num * 1000) / 1000;
}

function makeQuad(left, right, top, bottom) {
    return [
        round(left), round(top),
        round(right), round(top),
        round(right), round(bottom),
        round(left), round(bottom)
    ];
}

function textItemToLineCandidate(item, viewport, styles) {
    if (!item.str || !item.str.trim()) {
        return null;
    }

    const transform = Util.transform(viewport.transform, item.transform);
    const style = styles[item.fontName] || {};
    const scaleX = Math.hypot(transform[0], transform[1]);
    const scaleY = Math.hypot(transform[2], transform[3]);
    const fontHeight = scaleY || scaleX || style.fontSize || 0;
    const fontSize = Math.round((fontHeight || style.fontSize || 0) * 1000) / 1000;
    const width = item.width;
    if (!width || width <= 0) {
        return null;
    }

    const ascentFactor = typeof style.ascent === 'number' ? style.ascent : 1;
    const descentFactor = typeof style.descent === 'number' ? Math.abs(style.descent) : 0;
    const ascent = fontHeight * ascentFactor;
    const descent = fontHeight * descentFactor;

    const x = transform[4];
    const y = transform[5];

    const left = x;
    const right = x + width;
    const topCss = y - ascent;
    const bottomCss = y + descent;
    const top = viewport.height - topCss;
    const bottom = viewport.height - bottomCss;
    const quad = makeQuad(left, right, top, bottom);
    const baseline = viewport.height - y;

    return {
        text: item.str,
        quad,
        left,
        right,
        top,
        bottom,
        baseline,
        fontSize: fontSize || style.fontSize || 0,
        fontFamily: style.fontFamily || null,
        fontWeight: style.fontWeight || 'normal',
        mcid: typeof item.markedContentId === 'number' ? item.markedContentId : null
    };
}

function mergeIntoLines(items, viewport, styles) {
    const lines = [];
    const tolerance = 1.2;

    for (const item of items) {
        const candidate = textItemToLineCandidate(item, viewport, styles);
        if (!candidate) {
            continue;
        }
        let targetLine = null;
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (Math.abs(line.baseline - candidate.baseline) <= tolerance) {
                targetLine = line;
                break;
            }
        }
        if (!targetLine) {
            targetLine = {
                items: [],
                baseline: candidate.baseline
            };
            lines.push(targetLine);
        }
        targetLine.items.push(candidate);
    }

    const normalized = [];
    for (const line of lines) {
        if (!line.items.length) {
            continue;
        }
        line.items.sort((a, b) => a.left - b.left);
        const text = line.items.map(x => x.text).join('');
        if (!text.trim()) {
            continue;
        }
        const left = Math.min(...line.items.map(x => x.left));
        const right = Math.max(...line.items.map(x => x.right));
        const top = Math.max(...line.items.map(x => x.top));
        const bottom = Math.min(...line.items.map(x => x.bottom));
        const fontSizes = line.items.map(x => x.fontSize || 0).filter(Boolean);
        const avgFont = fontSizes.length ? fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length : 0;
        const mcids = new Set();
        line.items.forEach(x => { if (x.mcid !== null) { mcids.add(x.mcid); } });

        normalized.push({
            text,
            left,
            right,
            top,
            bottom,
            fontSize: avgFont,
            quad: makeQuad(left, right, top, bottom),
            mcids: Array.from(mcids)
        });
    }

    normalized.sort((a, b) => b.top - a.top);
    return normalized;
}

function groupLinesIntoBlocksDefault(lines) {
    const blocks = [];
    const gapMultiplier = 1.8;

    let current = null;
    for (const line of lines) {
        if (!current) {
            current = {
                lines: [line],
                top: line.top,
                bottom: line.bottom,
                maxFontSize: line.fontSize,
                mcids: new Set(line.mcids)
            };
            continue;
        }
        const gap = current.lines[current.lines.length - 1].bottom - line.top;
        const threshold = gapMultiplier * Math.max(current.lines[current.lines.length - 1].fontSize || 0, line.fontSize || 0, 8);
        if (gap <= threshold) {
            current.lines.push(line);
            current.bottom = line.bottom;
            current.maxFontSize = Math.max(current.maxFontSize, line.fontSize);
            line.mcids.forEach(id => current.mcids.add(id));
        } else {
            blocks.push(current);
            current = {
                lines: [line],
                top: line.top,
                bottom: line.bottom,
                maxFontSize: line.fontSize,
                mcids: new Set(line.mcids)
            };
        }
    }
    if (current) {
        blocks.push(current);
    }

    return blocks;
}

function groupLinesIntoBlocksStrict(lines) {
    const blocks = [];
    const gapMultiplier = 1.3;
    const dynamicMultiplier = 1.4;

    function median(arr) {
        if (!arr || !arr.length) return 0;
        const s = arr.slice().sort((a,b)=>a-b);
        const m = Math.floor(s.length/2);
        return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
    }

    function areMcidsDisjoint(a, b) {
        if (!a || !b || !a.length || !b.length) return false;
        const setB = new Set(b);
        for (const id of a) { if (setB.has(id)) return false; }
        return true;
    }

    let current = null;
    for (const line of lines) {
        if (!current) {
            current = {
                lines: [line],
                top: line.top,
                bottom: line.bottom,
                maxFontSize: line.fontSize,
                mcids: new Set(line.mcids),
                gaps: []
            };
            continue;
        }
        const prev = current.lines[current.lines.length - 1];
        const gap = prev.bottom - line.top;
        const baseThreshold = gapMultiplier * Math.max(prev.fontSize || 0, line.fontSize || 0, 8);
        const dynThresh = current.gaps.length ? (median(current.gaps) * dynamicMultiplier) : baseThreshold;
        const threshold = Math.min(baseThreshold, dynThresh);
        const splitByMcid = areMcidsDisjoint(prev.mcids || [], line.mcids || []);

        if (!splitByMcid && gap <= threshold) {
            current.lines.push(line);
            current.gaps.push(Math.max(0, gap));
            current.bottom = line.bottom;
            current.maxFontSize = Math.max(current.maxFontSize, line.fontSize);
            line.mcids.forEach(id => current.mcids.add(id));
        } else {
            blocks.push(current);
            current = {
                lines: [line],
                top: line.top,
                bottom: line.bottom,
                maxFontSize: line.fontSize,
                mcids: new Set(line.mcids),
                gaps: []
            };
        }
    }
    if (current) {
        blocks.push(current);
    }

    return blocks;
}

function classifyBlock(block, context) {
    const { titleAssigned } = context;
    const size = block.maxFontSize || 0;
    if (!context.titleAssigned && size >= context.thresholds.title) {
        context.titleAssigned = true;
        return 'Title';
    }
    if (size >= context.thresholds.heading) {
        return 'H1';
    }
    return 'P';
}

async function extractPdfGeometry(pdfPath, options = {}) {
    const language = options.language || 'en';
    const thresholds = Object.assign({ title: 18, heading: 14 }, options.thresholds || {});
    const idQueues = {};
    if (options.idQueues && typeof options.idQueues === 'object') {
        for (const [role, values] of Object.entries(options.idQueues)) {
            if (Array.isArray(values) && values.length) {
                idQueues[role] = values.slice();
            }
        }
    }

    // Pre-compute float anchor maps if requested
    const floatRoles = ['FIG', 'TABLE'];
    const floatIds = [];
    const floatEndIds = [];
    for (const role of floatRoles) {
        if (idQueues[role] && idQueues[role].length) {
            for (const id of idQueues[role]) {
                floatIds.push(id);
                floatEndIds.push(`${id}-end`);
            }
        }
    }

    const absolutePath = path.resolve(pdfPath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`PDF not found at ${absolutePath}`);
    }

    const rawBuffer = fs.readFileSync(absolutePath);
    const docId = crypto.createHash('sha256').update(rawBuffer).digest('hex');
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(rawBuffer), useSystemFonts: true, verbosity: 0 });
    const pdfDocument = await loadingTask.promise;

    // Extract anchors for anchor-guided strict mode (paragraphs)
    let anchorMap = null;
    const useAnchorMode = options.groupingMode === 'strict' && idQueues.P && idQueues.P.length;
    if (useAnchorMode) {
        anchorMap = await extractParagraphAnchors(pdfDocument, idQueues.P);
    }

    // Extract float anchors (figures/tables) if any
    let floatAnchorStartMap = null;
    let floatAnchorEndMap = null;
    if (floatIds.length) {
        floatAnchorStartMap = await extractParagraphAnchors(pdfDocument, floatIds);
    }
    if (floatEndIds.length) {
        floatAnchorEndMap = await extractParagraphAnchors(pdfDocument, floatEndIds);
    }

    const pages = [];
    let elementCounter = 1;
    const classifierContext = { titleAssigned: false, thresholds };
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        if (process.env.DEBUG_GEOMETRY) {
            console.log('PAGE', pageNumber, 'viewport.height', viewport.height, 'viewBox', page.view);
        }
        const textContent = await page.getTextContent({ includeMarkedContent: true });

        const lines = mergeIntoLines(textContent.items, viewport, textContent.styles);
        
        let elements;
        if (useAnchorMode && anchorMap) {
            elements = await processPageWithAnchors(lines, pageNumber - 1, anchorMap, classifierContext, thresholds, language, elementCounter);
            elementCounter += elements.length;
        } else {
            const groupingMode = options.groupingMode === 'strict' ? 'strict' : 'default';
            const blocks = groupingMode === 'strict'
                ? groupLinesIntoBlocksStrict(lines)
                : groupLinesIntoBlocksDefault(lines);

            elements = blocks.map(block => {
                const role = classifyBlock(block, classifierContext);
                const quads = block.lines.map(line => line.quad);
                const mcids = Array.from(block.mcids).sort((a, b) => a - b);

                // Compute a single paragraph-level bounding quad that encloses all line quads
                let paragraphQuad = null;
                if (block.lines && block.lines.length) {
                    const left = Math.min(...block.lines.map(l => Math.min(l.left, l.right)));
                    const right = Math.max(...block.lines.map(l => Math.max(l.left, l.right)));
                    const top = Math.max(...block.lines.map(l => l.top));
                    const bottom = Math.min(...block.lines.map(l => l.bottom));
                    paragraphQuad = makeQuad(left, right, top, bottom);
                }

                let queue = idQueues[role];
                if ((!queue || !queue.length) && role === 'Title' && idQueues.H1 && idQueues.H1.length) {
                    queue = idQueues.H1;
                }
                let elementId = null;
                if (queue && queue.length) {
                    elementId = queue.shift();
                }
                const element = {
                    id: elementId || `e_${String(elementCounter).padStart(4, '0')}`,
                    role,
                    lang: language,
                    quads
                };
                if (paragraphQuad) {
                    element.paragraphQuad = paragraphQuad;
                }
                if (mcids.length) {
                    element.mcids = mcids;
                }
                elementCounter += 1;
                return element;
            });
        }

        // Add float geometry for this page by pairing start/end anchors
        const pageIndex = pageNumber - 1;
        if (floatAnchorStartMap && floatAnchorEndMap && (floatIds.length || floatEndIds.length)) {
            // Determine margins (assume LaTeX geometry margin=1in => 72pt)
            const leftMargin = 72;
            const rightMargin = viewport.width - 72;

            for (const role of floatRoles) {
                const list = idQueues[role] || [];
                for (const id of list) {
                    const startInfo = floatAnchorStartMap.get(id);
                    const endInfo = floatAnchorEndMap.get(`${id}-end`);
                    if (!startInfo || startInfo.pageIndex !== pageIndex) continue;
                    if (!endInfo || endInfo.pageIndex !== pageIndex) continue;
                    const yTop = Math.max(startInfo.y, endInfo.y);
                    const yBottom = Math.min(startInfo.y, endInfo.y);
                    const quad = makeQuad(leftMargin, rightMargin, yTop, yBottom);
                    elements.push({
                        id,
                        role,
                        lang: language,
                        quads: [quad],
                        paragraphQuad: quad
                    });
                }
            }
        }

        pages.push({
            index: pageNumber - 1,
            elements
        });
        await page.cleanup();
    }

    await loadingTask.destroy();

    return {
        pdfGeometryV1: {
            docId,
            pages
        }
    };
}

async function extractParagraphAnchors(pdfDocument, paraIds) {
    // Build a map: id -> { pageIndex, y }
    const result = new Map();
    // pdfjs named destination API varies; try destinations by name via getDestination
    for (const id of paraIds) {
        try {
            const dest = await pdfDocument.getDestination(id);
            if (!dest || !dest[0]) continue;
            const ref = dest[0];
            const page = await pdfDocument.getPageIndex(ref);
            // dest array: [ref, name, left, top, zoom]
            // top is in PDF user space coordinates from bottom; we store as page Y
            let top = null;
            if (Array.isArray(dest) && dest.length >= 4 && typeof dest[3] === 'number') {
                top = dest[3];
            }
            result.set(id, { pageIndex: page, y: top });
        } catch (e) {
            // ignore missing destinations
        }
    }
    return result;
}

function sliceLinesByAnchors(lines, anchorsOnPage, viewportHeight) {
    // anchorsOnPage: [{ id, y }] with PDF Y up from bottom; our lines.top/bottom are already PDF space from bottom
    // Sort anchors descending (top to bottom visually): higher Y is higher on page
    const sorted = anchorsOnPage
        .filter(a => typeof a.y === 'number')
        .sort((a, b) => b.y - a.y);
    if (!sorted.length) return [];

    // Build segments between anchors: [ [yTop, yBottom, id] ... ]
    const segments = [];
    for (let i = 0; i < sorted.length; i++) {
        const current = sorted[i];
        const next = sorted[i + 1];
        const yTop = current.y;
        const yBottom = next ? next.y : -Infinity;
        segments.push({ id: current.id, yTop, yBottom });
    }

    // For each segment, collect lines whose baseline/top fall within [yBottom, yTop]
    const result = [];
    for (const seg of segments) {
        const segLines = lines.filter(l => {
            // Use the center line Y ~ baseline for assignment
            const centerY = (l.top + l.bottom) / 2;
            return centerY <= seg.yTop && centerY >= seg.yBottom;
        });
        if (segLines.length) {
            result.push({ id: seg.id, lines: segLines });
        }
    }
    return result;
}

async function processPageWithAnchors(lines, pageIndex, anchorMap, classifierContext, thresholds, language, startCounter) {
    // Collect anchors for this page
    const anchorsOnPage = [];
    for (const [id, info] of anchorMap.entries()) {
        if (info.pageIndex === pageIndex) anchorsOnPage.push({ id, y: info.y });
    }
    if (!anchorsOnPage.length) {
        // Fallback: no anchors, return empty (caller will still push page with empty elements)
        return [];
    }

    const segments = sliceLinesByAnchors(lines, anchorsOnPage);
    const elements = [];
    let counter = startCounter;

    for (const seg of segments) {
        const block = {
            lines: seg.lines,
            top: Math.max(...seg.lines.map(l => l.top)),
            bottom: Math.min(...seg.lines.map(l => l.bottom)),
            maxFontSize: Math.max(...seg.lines.map(l => l.fontSize || 0)),
            mcids: new Set(seg.lines.flatMap(l => l.mcids || []))
        };
        const role = 'P'; // anchor-guided paragraphs are explicit P
        const quads = block.lines.map(line => line.quad);
        const left = Math.min(...block.lines.map(l => Math.min(l.left, l.right)));
        const right = Math.max(...block.lines.map(l => Math.max(l.left, l.right)));
        const top = Math.max(...block.lines.map(l => l.top));
        const bottom = Math.min(...block.lines.map(l => l.bottom));
        const paragraphQuad = makeQuad(left, right, top, bottom);
        const mcids = Array.from(block.mcids).sort((a, b) => a - b);
        const element = {
            id: seg.id,
            role,
            lang: language,
            quads,
            paragraphQuad
        };
        if (mcids.length) element.mcids = mcids;
        elements.push(element);
        counter += 1;
    }
    return elements;
}

module.exports = {
    extractPdfGeometry
};
