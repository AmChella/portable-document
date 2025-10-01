// Set PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

class PDFHighlightViewer {
    constructor() {
        this.pdfDoc = null;
        this.currentPage = 1;
        this.pageRendering = false;
        this.pageNumPending = null;
        this.scale = 1.5;
        this.geometryData = null;
        this.currentHighlight = null;
        this.canvas = document.getElementById('pdfCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.overlayCanvas = document.getElementById('overlayCanvas');
        this.overlayCtx = this.overlayCanvas.getContext('2d');
        this.contextMenu = document.getElementById('contextMenu');
        this.currentClickedElement = null;
        this.textContent = null;
        this.textItems = [];
        this.currentWord = null;
        this.imageItems = [];
        this.imageCounter = 0;
    // Removed table/reference detection per request
    // Tooltip interaction mode: 'click' (default now) or 'hover'
    this.tooltipMode = 'click';
    // Track whether a tooltip is pinned due to click
    this.tooltipPinned = false;

    // Quad mode toggle: true => prefer paragraphQuad; false => use line-level quads
    this.useParagraphQuad = true;

    // Debug overlay: draw both paragraph and line quads for hovered element
    this.debugQuadOverlay = false;

    // Text selection mode
    this.selectionMode = false;
    this.isSelecting = false;
    this.selectionStart = null; // canvas coords
    this.selectionRect = null; // { left, top, right, bottom } in canvas coords

    // Line spacing analysis state
    this.lineSpacingEnabled = false;
    this.lineGroups = []; // grouped lines with baseline info
    this.lineSpacingMedian = 0;
    this.lineMismatches = []; // subset of lineGroups flagged
    this.lineSpacingThresholdPct = 15; // configurable later

        this.initializeEventListeners();
        this.initializeMenuHandlers();

        // Modal setup
        this.coordModal = document.getElementById('coordModal');
        this.coordForm = document.getElementById('coordForm');
        this.coordFormStatus = document.getElementById('coordFormStatus');
        this.coordinateEndpoint = '/api/coordinates'; // configurable endpoint
        this.setupModalHandlers();
    }

    initializeEventListeners() {
        document.getElementById('pdfFile').addEventListener('change', (e) => this.handlePDFUpload(e));
        document.getElementById('jsonFile').addEventListener('change', (e) => this.handleJSONUpload(e));
        document.getElementById('prevPage').addEventListener('click', () => this.onPrevPage());
        document.getElementById('nextPage').addEventListener('click', () => this.onNextPage());
        const lineToggle = document.getElementById('lineSpacingToggle');
        if (lineToggle) {
            lineToggle.addEventListener('click', () => {
                if (!this.pdfDoc) return;
                this.lineSpacingEnabled = !this.lineSpacingEnabled;
                lineToggle.classList.toggle('active', this.lineSpacingEnabled);
                lineToggle.textContent = this.lineSpacingEnabled ? 'Line Spacing (On)' : 'Line Spacing';
                if (this.lineSpacingEnabled) {
                    this.computeLineSpacingMetrics();
                } else {
                    this.redrawCurrentOverlay();
                }
            });
        }
        const selectToggle = document.getElementById('selectModeToggle');
        if (selectToggle) {
            const updateSelectButton = () => { selectToggle.textContent = this.selectionMode ? 'Text Select (On)' : 'Text Select (Off)'; };
            updateSelectButton();
            selectToggle.addEventListener('click', () => {
                if (!this.pdfDoc) return;
                this.selectionMode = !this.selectionMode;
                // Cancel any active selection when toggling off
                if (!this.selectionMode) { this.isSelecting = false; this.selectionStart = null; this.selectionRect = null; }
                updateSelectButton();
                this.redrawCurrentOverlay();
            });
        }
        const quadToggle = document.getElementById('quadModeToggle');
        if (quadToggle) {
            const updateQuadButton = () => { quadToggle.textContent = this.useParagraphQuad ? 'Paragraph Quads (On)' : 'Paragraph Quads (Off)'; };
            updateQuadButton();
            quadToggle.addEventListener('click', () => {
                if (!this.geometryData) return; // only relevant when geometry is loaded
                this.useParagraphQuad = !this.useParagraphQuad;
                updateQuadButton();
                this.redrawCurrentOverlay();
            });
        }
        const quadDebugToggle = document.getElementById('quadDebugToggle');
        if (quadDebugToggle) {
            const updateDebugButton = () => { quadDebugToggle.textContent = this.debugQuadOverlay ? 'Quad Debug (On)' : 'Quad Debug (Off)'; };
            updateDebugButton();
            quadDebugToggle.addEventListener('click', () => {
                if (!this.geometryData) return;
                this.debugQuadOverlay = !this.debugQuadOverlay;
                updateDebugButton();
                this.redrawCurrentOverlay();
            });
        }
    this.overlayCanvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.overlayCanvas.addEventListener('mouseleave', () => this.handleMouseLeave());
    this.overlayCanvas.addEventListener('click', (e) => this.handleClick(e));
    this.overlayCanvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.handleContextMenu(e); });
        this.overlayCanvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.overlayCanvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));

        // Close context menu when clicking elsewhere
        document.addEventListener('click', (e) => {
            if (!this.contextMenu.contains(e.target) && e.target !== this.overlayCanvas) {
                this.hideContextMenu();
            }
        });

        // Allow ESC to unpin tooltip
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.tooltipPinned) {
                this.tooltipPinned = false;
                this.hideTooltip();
                this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
            }
        });
    }

    setupModalHandlers() {
        if (!this.coordModal) return;
        // Close triggers
        this.coordModal.querySelectorAll('[data-close-modal]').forEach(btn => {
            btn.addEventListener('click', () => this.closeCoordModal());
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.coordModal.classList.contains('hidden')) {
                this.closeCoordModal();
            }
        });
        if (this.coordForm) {
            this.coordForm.addEventListener('submit', (e) => this.handleCoordSubmit(e));
        }
    }

    openCoordModal(payload) {
        if (!this.coordModal) return;
        this.populateCoordForm(payload);
        this.coordModal.classList.remove('hidden');
        this.coordModal.setAttribute('aria-hidden', 'false');
        // focus first field
        const first = this.coordModal.querySelector('select, input, textarea');
        if (first) setTimeout(()=> first.focus(), 50);
    }

    closeCoordModal() {
        if (!this.coordModal) return;
        this.coordModal.classList.add('hidden');
        this.coordModal.setAttribute('aria-hidden', 'true');
        if (this.coordFormStatus) { this.coordFormStatus.textContent=''; this.coordFormStatus.className='form-status'; }
    }

    populateCoordForm(data) {
        if (!this.coordForm) return;
        const { type, page, pdfX, pdfY, canvasX, canvasY, reference, notes, lineNumber, lineText } = data;
        const setVal = (id,val)=> { const el = document.getElementById(id); if (el) el.value = (val ?? '') === undefined ? '' : val; };
        setVal('coordItemType', type);
        setVal('coordPage', page);
        setVal('coordPdfX', pdfX?.toFixed ? pdfX.toFixed(2) : pdfX);
        setVal('coordPdfY', pdfY?.toFixed ? pdfY.toFixed(2) : pdfY);
        setVal('coordCanvasX', canvasX?.toFixed ? canvasX.toFixed(0) : canvasX);
        setVal('coordCanvasY', canvasY?.toFixed ? canvasY.toFixed(0) : canvasY);
        setVal('coordReference', reference || '');
        setVal('coordNotes', notes || '');
        setVal('coordLineNumber', lineNumber ?? '');
        setVal('coordLineText', lineText || '');
    }

    async handleCoordSubmit(event) {
        event.preventDefault();
        if (!this.coordForm) return;
        const formData = new FormData(this.coordForm);
        const payload = Object.fromEntries(formData.entries());
        // Convert numerics
    ['page','pdfX','pdfY','canvasX','canvasY','lineNumber'].forEach(k=> { if (payload[k] !== undefined && payload[k] !== '') payload[k] = Number(payload[k]); });
        this.setCoordFormStatus('Submitting...', '');
        try {
            const res = await fetch(this.coordinateEndpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
            if (!res.ok) throw new Error(`Server responded ${res.status}`);
            this.setCoordFormStatus('Submitted successfully.', 'success');
            setTimeout(()=> this.closeCoordModal(), 800);
            this.showStatus('Coordinate submitted', 'success');
        } catch (err) {
            console.error('Coordinate submit error:', err);
            this.setCoordFormStatus('Submission failed. Check console / server.', 'error');
            this.showStatus('Coordinate submission failed', 'error');
        }
    }

    setCoordFormStatus(message, type) {
        if (!this.coordFormStatus) return;
        this.coordFormStatus.textContent = message;
        this.coordFormStatus.className = 'form-status' + (type ? ' ' + type : '');
    }

    initializeMenuHandlers() {
        // Define available menu handlers that can be used
        this.menuHandlers = {
            copy: (element) => {
                console.log('Copy action for element:', element.id);
                this.showStatus(`Copied element ${element.id}`, 'success');
            },
            highlight: (element) => {
                console.log('Highlight action for element:', element.id);
                this.showStatus(`Highlighted element ${element.id}`, 'success');
            },
            annotate: (element) => {
                console.log('Annotate action for element:', element.id);
                const note = prompt('Enter annotation:');
                if (note) {
                    this.showStatus(`Added annotation to element ${element.id}`, 'success');
                }
            },
            delete: (element) => {
                console.log('Delete action for element:', element.id);
                if (confirm(`Delete element ${element.id}?`)) {
                    this.showStatus(`Deleted element ${element.id}`, 'success');
                }
            },
            properties: (element) => {
                const quads = this.getElementQuads(element);
                const props = `Element Properties:\n\nID: ${element.id}\nRole: ${element.role}\nLanguage: ${element.lang || 'N/A'}\nQuads: ${quads.length}${element.paragraphQuad ? ' (paragraph)' : ''}`;
                alert(props);
            },
            export: (element) => {
                console.log('Export action for element:', element.id);
                const data = JSON.stringify(element, null, 2);
                const blob = new Blob([data], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `element_${element.id}.json`;
                a.click();
                URL.revokeObjectURL(url);
                this.showStatus(`Exported element ${element.id}`, 'success');
            },
            translate: (element) => {
                console.log('Translate action for element:', element.id);
                this.showStatus(`Translation requested for element ${element.id}`, 'info');
            },
            search: (element) => {
                console.log('Search action for element:', element.id);
                this.showStatus(`Searching for similar elements...`, 'info');
            }
        };
    }

    getMenuOptionsForElement(element) {
        const menuOptions = [];
        menuOptions.push({ type: 'header', label: `Element: ${element.id}` });
        menuOptions.push({ label: 'Copy', icon: '📋', handler: () => this.menuHandlers.copy(element) });
        if (element.role === 'H1' || element.role === 'H2' || element.role === 'H3') {
            menuOptions.push({ label: 'Create Bookmark', icon: '🔖', handler: () => this.menuHandlers.highlight(element) });
        }
        if (element.role === 'P') {
            menuOptions.push({ label: 'Annotate', icon: '✏️', handler: () => this.menuHandlers.annotate(element) });
            menuOptions.push({ label: 'Search Similar', icon: '🔍', handler: () => this.menuHandlers.search(element) });
        }
        if (element.lang && element.lang !== 'en') {
            menuOptions.push({ label: 'Translate', icon: '🌐', handler: () => this.menuHandlers.translate(element) });
        }
        menuOptions.push({ type: 'divider' });
        menuOptions.push({ label: 'Properties', icon: 'ℹ️', handler: () => this.menuHandlers.properties(element) });
        menuOptions.push({ label: 'Export', icon: '💾', handler: () => this.menuHandlers.export(element) });
        if (element.role !== 'H1') {
            menuOptions.push({ label: 'Delete', icon: '🗑️', handler: () => this.menuHandlers.delete(element), className: 'danger' });
        }
        return menuOptions;
    }

    showStatus(message, type = 'info') {
        const statusEl = document.getElementById('statusMessage');
        statusEl.className = `status-message ${type}`;
        statusEl.textContent = message;
        statusEl.style.display = 'block';
        if (type !== 'error') {
            setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
        }
    }

    async handlePDFUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        this.showStatus('Loading PDF...', 'info');
        try {
            const arrayBuffer = await file.arrayBuffer();
            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
            this.pdfDoc = await loadingTask.promise;
            document.getElementById('pageCount').textContent = this.pdfDoc.numPages;
            document.getElementById('prevPage').disabled = false;
            document.getElementById('nextPage').disabled = false;
            document.getElementById('emptyState').style.display = 'none';
            document.getElementById('pageWrapper').style.display = 'block';
            this.currentPage = 1;
            await this.renderPage(this.currentPage);
            this.showStatus('PDF loaded successfully!', 'success');
            const lineToggle = document.getElementById('lineSpacingToggle');
            if (lineToggle) lineToggle.disabled = false;
            const selectToggle = document.getElementById('selectModeToggle');
            if (selectToggle) { selectToggle.disabled = false; selectToggle.textContent = this.selectionMode ? 'Text Select (On)' : 'Text Select (Off)'; }
        } catch (error) {
            console.error('Error loading PDF:', error);
            this.showStatus('Error loading PDF. Please try another file.', 'error');
        }
    }

    async handleJSONUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.pdfGeometryV1 || !data.pdfGeometryV1.pages) throw new Error('Invalid JSON format');
            this.geometryData = data.pdfGeometryV1;
            const quadToggle = document.getElementById('quadModeToggle');
            if (quadToggle) { quadToggle.disabled = false; quadToggle.textContent = this.useParagraphQuad ? 'Paragraph Quads (On)' : 'Paragraph Quads (Off)'; }
            const quadDebugToggle = document.getElementById('quadDebugToggle');
            if (quadDebugToggle) { quadDebugToggle.disabled = false; quadDebugToggle.textContent = this.debugQuadOverlay ? 'Quad Debug (On)' : 'Quad Debug (Off)'; }
            if (this.pdfDoc) await this.renderPage(this.currentPage);
            this.showStatus('Geometry data loaded successfully!', 'success');
        } catch (error) {
            console.error('Error loading JSON:', error);
            this.showStatus('Error loading JSON. Please check the file format.', 'error');
        }
    }

    async renderPage(num) {
        this.pageRendering = true;
        try {
            const page = await this.pdfDoc.getPage(num);
            const viewport = page.getViewport({ scale: this.scale });
            this.canvas.height = viewport.height;
            this.canvas.width = viewport.width;
            this.overlayCanvas.height = viewport.height;
            this.overlayCanvas.width = viewport.width;
            const renderContext = { canvasContext: this.ctx, viewport: viewport };
            await page.render(renderContext).promise;
            await this.extractTextContent(page);
            await this.extractImageContent(page);
            document.getElementById('pageNum').textContent = num;
            this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
            if (this.lineSpacingEnabled) {
                this.computeLineSpacingMetrics();
            }
            this.pageRendering = false;
            if (this.pageNumPending !== null) {
                await this.renderPage(this.pageNumPending);
                this.pageNumPending = null;
            }
        } catch (error) {
            console.error('Error rendering page:', error);
            this.pageRendering = false;
        }
    }

    async extractTextContent(page) {
        try {
            this.textContent = await page.getTextContent();
            this.textItems = [];
            for (const item of this.textContent.items) {
                if (item.str.trim()) {
                    const words = this.splitIntoWords(item);
                    this.textItems.push(...words);
                }
            }
            this.computePageFontStats();
        } catch (error) {
            console.error('Error extracting text content:', error);
            this.textContent = null;
            this.textItems = [];
        }
    }

    computePageFontStats() {
        if (!this.textItems.length) {
            this.pageFontStats = { median:0, min:0, max:0 };
            return;
        }
        const sizes = this.textItems.map(i=> i.fontSize).sort((a,b)=>a-b);
        const mid = Math.floor(sizes.length/2);
        const median = sizes.length % 2 ? sizes[mid] : (sizes[mid-1]+sizes[mid])/2;
        this.pageFontStats = { median, min: sizes[0], max: sizes[sizes.length-1] };
    }

    splitIntoWords(textItem) {
        const words = [];
        const text = textItem.str;
        const transform = textItem.transform;
        const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
        const fontSizeY = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
        const wordPattern = /\S+/g;
        let match;
        while ((match = wordPattern.exec(text)) !== null) {
            const word = match[0];
            const startIndex = match.index;
            const charWidth = (textItem.width || fontSize * 0.6) / text.length;
            const wordX = transform[4] + (charWidth * startIndex);
            const wordY = transform[5];
            const wordWidth = charWidth * word.length;
            const wordHeight = fontSize;
            words.push({
                str: word, x: wordX, y: wordY, width: wordWidth, height: wordHeight, fontSize, fontSizeY,
                transform, startIndex, endIndex: startIndex + word.length - 1, originalItem: textItem
            });
        }
        return words;
    }

    getWordAtPosition(x, y) {
        if (!this.textItems.length) return null;
        const pdfX = x / this.scale;
        const pdfY = (this.canvas.height - y) / this.scale;
        for (const item of this.textItems) {
            const itemLeft = item.x;
            const itemRight = item.x + item.width;
            const itemBottom = item.y - item.height * 0.2;
            const itemTop = item.y + item.height * 0.8;
            if (pdfX >= itemLeft && pdfX <= itemRight && pdfY >= itemBottom && pdfY <= itemTop) {
                const charWidth = item.width / item.str.length;
                const relativeX = pdfX - item.x;
                const charIndex = Math.floor(relativeX / charWidth);
                return {
                    word: item.str,
                    x: item.x,
                    y: item.y,
                    width: item.width,
                    height: item.height,
                    fontSize: item.fontSize,
                    charIndex: Math.max(0, Math.min(charIndex, item.str.length - 1)),
                    globalCharIndex: item.startIndex + charIndex,
                    coordinates: { pdfX, pdfY, canvasX: x, canvasY: y },
                    bounds: {
                        left: itemLeft * this.scale,
                        right: itemRight * this.scale,
                        top: (this.canvas.height / this.scale - itemTop) * this.scale,
                        bottom: (this.canvas.height / this.scale - itemBottom) * this.scale
                    }
                };
            }
        }
        return null;
    }

    async extractImageContent(page) {
        try {
            this.imageCounter = 0;
            this.imageItems = [];
            const ops = await page.getOperatorList();
            let transform = [1, 0, 0, 1, 0, 0];
            let transformStack = [];
            for (let i = 0; i < ops.fnArray.length; i++) {
                const fn = ops.fnArray[i];
                const args = ops.argsArray[i];
                if (fn === pdfjsLib.OPS.save) {
                    transformStack.push([...transform]);
                } else if (fn === pdfjsLib.OPS.restore) {
                    if (transformStack.length > 0) transform = transformStack.pop();
                } else if (fn === pdfjsLib.OPS.transform) {
                    const [a, b, c, d, e, f] = args;
                    const [ta, tb, tc, td, te, tf] = transform;
                    transform = [
                        ta * a + tb * c,
                        ta * b + tb * d,
                        tc * a + td * c,
                        tc * b + td * d,
                        te * a + tf * c + e,
                        te * b + tf * d + f
                    ];
                } else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject || fn === pdfjsLib.OPS.paintImageMaskXObject) {
                    this.imageCounter++;
                    const bounds = this.calculateImageBounds(transform);
                    this.imageItems.push({ imageNumber: this.imageCounter, type: 'image', bounds, transform: [...transform], operatorType: fn, pageNumber: page.pageNumber });
                }
            }
        } catch (error) {
            console.error('Error extracting image content:', error);
            this.imageItems = [];
            this.imageCounter = 0;
        }
    }

    calculateImageBounds(transform) {
        const [a, b, c, d, e, f] = transform;
        const corners = [[0,0],[1,0],[1,1],[0,1]];
        const transformedCorners = corners.map(([x,y]) => [a*x + c*y + e, b*x + d*y + f]);
        const xs = transformedCorners.map(([x]) => x);
        const ys = transformedCorners.map(([,y]) => y);
        return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys), width: Math.max(...xs)-Math.min(...xs), height: Math.max(...ys)-Math.min(...ys) };
    }

    getImageAtPosition(x, y) {
        if (!this.imageItems.length) return null;
        const pdfX = x / this.scale;
        const pdfY = (this.canvas.height - y) / this.scale;
        for (const image of this.imageItems) {
            const bounds = image.bounds;
            if (pdfX >= bounds.left && pdfX <= bounds.right && pdfY >= bounds.bottom && pdfY <= bounds.top) {
                return { imageNumber: image.imageNumber, type: image.type, bounds: image.bounds, pageNumber: image.pageNumber, coordinates: { pdfX, pdfY, canvasX: x, canvasY: y }, canvasBounds: { left: bounds.left * this.scale, right: bounds.right * this.scale, top: (this.canvas.height / this.scale - bounds.top) * this.scale, bottom: (this.canvas.height / this.scale - bounds.bottom) * this.scale } };
            }
        }
        return null;
    }


    calculateBounds(items) {
        if (!items.length) return null;
        const xs = items.map(i=>i.x);
        const ys = items.map(i=>i.y);
        const rights = items.map(i=>i.x + i.width);
        const bottoms = items.map(i=>i.y - i.height);
        return { left: Math.min(...xs), right: Math.max(...rights), top: Math.max(...ys), bottom: Math.min(...bottoms), width: Math.max(...rights)-Math.min(...xs), height: Math.max(...ys)-Math.min(...bottoms) };
    }

    /* ================= Line Grouping (Lightweight) ================= */
    // Returns cached grouping if already computed for current page & scale.
    getOrBuildLineGroups() {
        if (!this.textItems.length) return [];
        if (this._cachedLineGroups && this._cachedLineGroupsPage === this.currentPage) return this._cachedLineGroups;
        const tolerance = 4; // PDF units baseline tolerance
        const lines = [];
        for (const item of this.textItems) {
            let line = lines.find(l => Math.abs(l.y - item.y) <= tolerance);
            if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
            line.items.push(item);
        }
        // Sort lines visually top-to-bottom: PDF y higher means nearer top, so sort descending -> then reverse to top->bottom order
        lines.sort((a,b)=> b.y - a.y); // descending
        // Build textual representation
        let lineNumber = 1;
        for (const line of lines) {
            line.items.sort((a,b)=> a.x - b.x);
            // Column fragment detection: split on large horizontal gaps
            const words = line.items.map(w=> w.str);
            const gapThreshold = this.estimateColumnGapThreshold(line.items);
            const fragments = [];
            let current = [];
            let lastRight = null;
            for (const it of line.items) {
                if (lastRight !== null) {
                    const gap = it.x - lastRight;
                    if (gap > gapThreshold) { // start new fragment
                        if (current.length) fragments.push(current);
                        current = [];
                    }
                }
                current.push(it);
                lastRight = it.x + it.width;
            }
            if (current.length) fragments.push(current);
            line.fragments = fragments.map(fItems => ({
                items: fItems,
                text: fItems.map(fi=>fi.str).join(' '),
                left: Math.min(...fItems.map(fi=>fi.x)),
                right: Math.max(...fItems.map(fi=>fi.x + fi.width))
            }));
            line.text = line.fragments.map(f=>f.text).join('  '); // full line if needed
            line.number = lineNumber++;
            const left = Math.min(...line.items.map(i=>i.x));
            const right = Math.max(...line.items.map(i=>i.x + i.width));
            const maxFont = Math.max(...line.items.map(i=>i.fontSize));
            const top = line.y + maxFont * 0.8;
            const bottom = line.y - maxFont * 0.2;
            line.bounds = { left, right, top, bottom };
        }
        this._cachedLineGroups = lines;
        this._cachedLineGroupsPage = this.currentPage;
        return lines;
    }

    estimateColumnGapThreshold(items) {
        if (!items || items.length < 2) return 40; // default
        // Compute consecutive gaps
        const gaps = [];
        let lastRight = null;
        for (const it of items) {
            if (lastRight !== null) {
                const gap = it.x - lastRight;
                if (gap > 0) gaps.push(gap);
            }
            lastRight = it.x + it.width;
        }
        if (!gaps.length) return 40;
        // Use median gap * 2.5 as threshold (bigger indicates column break)
        const sorted = gaps.slice().sort((a,b)=>a-b);
        const mid = Math.floor(sorted.length/2);
        const median = sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
        const threshold = Math.max(40, median * 2.5); // enforce minimum
        return threshold;
    }

    // Removed reference/table classification & hit-testing per request

    queueRenderPage(num) {
        if (this.pageRendering) { this.pageNumPending = num; } else { this.renderPage(num); }
    }

    onPrevPage() {
        if (this.currentPage <= 1) return;
        this.currentPage--;
        this.queueRenderPage(this.currentPage);
        this.hideContextMenu();
    }

    onNextPage() {
        if (!this.pdfDoc || this.currentPage >= this.pdfDoc.numPages) return;
        this.currentPage++;
        this.queueRenderPage(this.currentPage);
        this.hideContextMenu();
    }

    handleClick(event) {
        // Left click toggles: submission popup vs text selection
        if (!this.pdfDoc) return;
        if (this.selectionMode) return; // in selection mode, clicks do not open the submission modal
        const rect = this.overlayCanvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (this.overlayCanvas.width / rect.width);
        const y = (event.clientY - rect.top) * (this.overlayCanvas.height / rect.height);
        const wordInfo = this.getWordAtPosition(x, y);
        const imageInfo = this.getImageAtPosition(x, y);
        let foundElement = null;
        if (this.geometryData) {
            const pageIndex = this.currentPage - 1;
            const pageGeometry = this.geometryData.pages.find(p => p.index === pageIndex);
            if (pageGeometry) {
                for (const element of pageGeometry.elements) { if (this.isPointInElement(x, y, element)) { foundElement = element; break; } }
            }
        }
        if (!wordInfo && !imageInfo && !foundElement) {
            this.hideContextMenu();
            return;
        }
        // Determine primary target preference order: word > image > element
        let type, payload, refText, lineMeta = { number:null, text:'' };
        const lineGroups = this.getOrBuildLineGroups();
        const resolveLineForWord = (wi) => {
            if (!wi) return null;
            // Find line whose bounds contain the pdfY of the word center
            const pdfY = wi.y; // baseline
            // Because baseline near bottom of the glyph, include tolerance
            let best = null; let minDelta = Infinity;
            for (const line of lineGroups) {
                const delta = Math.abs(line.y - pdfY);
                if (delta < minDelta) { minDelta = delta; best = line; }
            }
            return best;
        };
        const resolveLineForElement = (el) => {
            if (!el) return null;
            const quads = this.getElementQuads(el);
            if (!quads.length) return null;
            const quad = quads[0];
            const baselineY = quad[1];
            let best = null; let minDelta = Infinity;
            for (const line of lineGroups) {
                const delta = Math.abs(line.y - baselineY);
                if (delta < minDelta) { minDelta = delta; best = line; }
            }
            return best;
        };
        let resolvedLine = null;
        if (wordInfo) {
            type = 'word';
            refText = wordInfo.word;
            resolvedLine = resolveLineForWord(wordInfo);
            if (resolvedLine) lineMeta = { number: resolvedLine.number, text: resolvedLine.text };
            // Pick fragment containing the word
            if (resolvedLine && resolvedLine.fragments) {
                const pdfX = wordInfo.x;
                const frag = resolvedLine.fragments.find(f => pdfX >= f.left && pdfX <= f.right);
                if (frag) lineMeta.text = frag.text;
            }
            payload = { type, page: this.currentPage, pdfX: wordInfo.coordinates.pdfX, pdfY: wordInfo.coordinates.pdfY, canvasX: wordInfo.coordinates.canvasX, canvasY: wordInfo.coordinates.canvasY, reference: refText, lineNumber: lineMeta.number, lineText: lineMeta.text };
            this.overlayCtx.clearRect(0,0,this.overlayCanvas.width,this.overlayCanvas.height);
            if (this.lineSpacingEnabled) this.drawLineSpacingOverlay();
            this.highlightWord(wordInfo);
        } else if (imageInfo) {
            type = 'image';
            refText = `Image #${imageInfo.imageNumber}`;
            // Attempt to approximate line using vertical center to nearest baseline (less meaningful for images)
            const pseudoWord = { y: imageInfo.coordinates.pdfY };
            resolvedLine = resolveLineForWord(pseudoWord);
            if (resolvedLine) lineMeta = { number: resolvedLine.number, text: resolvedLine.text };
            if (resolvedLine && resolvedLine.fragments) {
                // Use nearest fragment by horizontal center of image
                const centerX = (imageInfo.bounds.left + imageInfo.bounds.right)/2;
                let best = null; let min = Infinity;
                for (const f of resolvedLine.fragments) {
                    const fCenter = (f.left + f.right)/2;
                    const d = Math.abs(centerX - fCenter);
                    if (d < min) { min = d; best = f; }
                }
                if (best) lineMeta.text = best.text;
            }
            payload = { type, page: this.currentPage, pdfX: imageInfo.coordinates.pdfX, pdfY: imageInfo.coordinates.pdfY, canvasX: imageInfo.coordinates.canvasX, canvasY: imageInfo.coordinates.canvasY, reference: refText, lineNumber: lineMeta.number, lineText: lineMeta.text };
            this.overlayCtx.clearRect(0,0,this.overlayCanvas.width,this.overlayCanvas.height);
            if (this.lineSpacingEnabled) this.drawLineSpacingOverlay();
            this.highlightImage(imageInfo);
        } else if (foundElement) {
            type = 'element';
            refText = foundElement.id || foundElement.role || 'element';
            // approximate pdf coords from first quad's first point
            let pdfX = null, pdfY = null;
            const elementQuads = this.getElementQuads(foundElement);
            if (elementQuads.length) { pdfX = elementQuads[0][0]; pdfY = elementQuads[0][1]; }
            resolvedLine = resolveLineForElement(foundElement);
            if (resolvedLine) lineMeta = { number: resolvedLine.number, text: resolvedLine.text };
            if (resolvedLine && resolvedLine.fragments && pdfX !== null) {
                const frag = resolvedLine.fragments.find(f => pdfX >= f.left && pdfX <= f.right);
                if (frag) lineMeta.text = frag.text;
            }
            const canvasX = x; const canvasY = y;
            payload = { type, page: this.currentPage, pdfX, pdfY, canvasX, canvasY, reference: refText, lineNumber: lineMeta.number, lineText: lineMeta.text };
            this.overlayCtx.clearRect(0,0,this.overlayCanvas.width,this.overlayCanvas.height);
            if (this.lineSpacingEnabled) this.drawLineSpacingOverlay();
            this.highlightElement(foundElement);
        }
        this.openCoordModal(payload);
    }

    handleContextMenu(event) {
        // Right-click (context menu) retains original context menu functionality
        if (!this.pdfDoc) return;
        const rect = this.overlayCanvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (this.overlayCanvas.width / rect.width);
        const y = (event.clientY - rect.top) * (this.overlayCanvas.height / rect.height);
        const wordInfo = this.getWordAtPosition(x, y);
        const imageInfo = this.getImageAtPosition(x, y);
        let foundElement = null;
        if (this.geometryData) {
            const pageIndex = this.currentPage - 1;
            const pageGeometry = this.geometryData.pages.find(p => p.index === pageIndex);
            if (pageGeometry) {
                for (const element of pageGeometry.elements) { if (this.isPointInElement(x, y, element)) { foundElement = element; break; } }
            }
        }
        if (foundElement) { this.currentClickedElement = foundElement; this.showContextMenu(event, foundElement); }
        else if (imageInfo) { this.showImageContextMenu(event, imageInfo); }
        else if (wordInfo) { this.showWordContextMenu(event, wordInfo); }
        else { this.hideContextMenu(); }
    }

    showContextMenu(event, element) {
        const menuOptions = this.getMenuOptionsForElement(element);
        let menuHTML = '';
        for (const option of menuOptions) {
            if (option.type === 'header') {
                menuHTML += `<div class="context-menu-header">${option.label}</div>`;
            } else if (option.type === 'divider') {
                menuHTML += '<div class="context-menu-divider"></div>';
            } else {
                const className = option.className ? ` ${option.className}` : '';
                menuHTML += `\n<div class="context-menu-item${className}" data-action="${option.label}">\n<span class="context-menu-icon">${option.icon || ''}</span>\n<span>${option.label}</span>\n</div>`;
            }
        }
        this.contextMenu.innerHTML = menuHTML;
        const menuItems = this.contextMenu.querySelectorAll('.context-menu-item');
        menuItems.forEach((item, index) => {
            const option = menuOptions.filter(opt => opt.type !== 'header' && opt.type !== 'divider')[index];
            if (option && option.handler) { item.addEventListener('click', () => { option.handler(); this.hideContextMenu(); }); }
        });
        let menuX = event.clientX; let menuY = event.clientY;
        const menuRect = this.contextMenu.getBoundingClientRect();
        if (menuX + 200 > window.innerWidth) menuX = window.innerWidth - 200;
        if (menuY + menuRect.height > window.innerHeight) menuY = window.innerHeight - menuRect.height;
        this.contextMenu.style.left = menuX + 'px';
        this.contextMenu.style.top = menuY + 'px';
        this.contextMenu.classList.add('visible');
    }

    showWordContextMenu(event, wordInfo) {
        const menuOptions = [
            { type: 'header', label: `Word: "${wordInfo.word}"` },
            { label: 'Copy Word', icon: '📋', handler: () => { navigator.clipboard.writeText(wordInfo.word); this.showStatus(`Copied word: ${wordInfo.word}`, 'success'); } },
            { label: 'Copy Character', icon: '📝', handler: () => { navigator.clipboard.writeText(wordInfo.word[wordInfo.charIndex]); this.showStatus(`Copied character: ${wordInfo.word[wordInfo.charIndex]}`, 'success'); } },
            { label: 'Copy Coordinates', icon: '📍', handler: () => { const coords = `PDF: (${wordInfo.coordinates.pdfX.toFixed(2)}, ${wordInfo.coordinates.pdfY.toFixed(2)})`; navigator.clipboard.writeText(coords); this.showStatus('Copied coordinates', 'success'); } },
            { type: 'divider' },
            { label: 'Word Info', icon: 'ℹ️', handler: () => { const info = `Word Information:\n\nWord: "${wordInfo.word}"\nCharacter: "${wordInfo.word[wordInfo.charIndex]}" (${wordInfo.charIndex + 1}/${wordInfo.word.length})\nFont Size: ${wordInfo.fontSize.toFixed(1)}px\nPDF Coordinates: (${wordInfo.coordinates.pdfX.toFixed(2)}, ${wordInfo.coordinates.pdfY.toFixed(2)})\nCanvas Coordinates: (${wordInfo.coordinates.canvasX.toFixed(0)}, ${wordInfo.coordinates.canvasY.toFixed(0)})`; alert(info); } }
        ];
        let menuHTML = '';
        for (const option of menuOptions) {
            if (option.type === 'header') menuHTML += `<div class="context-menu-header">${option.label}</div>`;
            else if (option.type === 'divider') menuHTML += '<div class="context-menu-divider"></div>';
            else { const className = option.className ? ` ${option.className}` : ''; menuHTML += `\n<div class="context-menu-item${className}" data-action="${option.label}">\n<span class="context-menu-icon">${option.icon || ''}</span>\n<span>${option.label}</span>\n</div>`; }
        }
        this.contextMenu.innerHTML = menuHTML;
        const menuItems = this.contextMenu.querySelectorAll('.context-menu-item');
        menuItems.forEach((item, index) => { const option = menuOptions.filter(opt => opt.type !== 'header' && opt.type !== 'divider')[index]; if (option && option.handler) { item.addEventListener('click', () => { option.handler(); this.hideContextMenu(); }); } });
        let menuX = event.clientX; let menuY = event.clientY;
        if (menuX + 200 > window.innerWidth) menuX = window.innerWidth - 200;
        if (menuY + 150 > window.innerHeight) menuY = window.innerHeight - 150;
        this.contextMenu.style.left = menuX + 'px';
        this.contextMenu.style.top = menuY + 'px';
        this.contextMenu.classList.add('visible');
    }

    showImageContextMenu(event, imageInfo) {
        const menuOptions = [
            { type: 'header', label: `Image #${imageInfo.imageNumber}` },
            { label: 'Copy Image Info', icon: '📋', handler: () => { const info = `Image #${imageInfo.imageNumber} - Page ${imageInfo.pageNumber}`; navigator.clipboard.writeText(info); this.showStatus(`Copied image info: ${info}`, 'success'); } },
            { label: 'Copy Coordinates', icon: '📍', handler: () => { const coords = `PDF: (${imageInfo.coordinates.pdfX.toFixed(2)}, ${imageInfo.coordinates.pdfY.toFixed(2)})`; navigator.clipboard.writeText(coords); this.showStatus('Copied image coordinates', 'success'); } },
            { label: 'Copy Dimensions', icon: '📏', handler: () => { const dims = `${imageInfo.bounds.width.toFixed(1)} x ${imageInfo.bounds.height.toFixed(1)} units`; navigator.clipboard.writeText(dims); this.showStatus('Copied image dimensions', 'success'); } },
            { type: 'divider' },
            { label: 'Image Properties', icon: 'ℹ️', handler: () => { const props = `Image Properties:\n\nImage Number: ${imageInfo.imageNumber}\nPage: ${imageInfo.pageNumber}\nPDF Coordinates: (${imageInfo.coordinates.pdfX.toFixed(2)}, ${imageInfo.coordinates.pdfY.toFixed(2)})\nCanvas Coordinates: (${imageInfo.coordinates.canvasX.toFixed(0)}, ${imageInfo.coordinates.canvasY.toFixed(0)})\nDimensions: ${imageInfo.bounds.width.toFixed(1)} x ${imageInfo.bounds.height.toFixed(1)} units\nType: ${imageInfo.type}`; alert(props); } },
            { label: 'Export Image Data', icon: '💾', handler: () => { const data = JSON.stringify(imageInfo, null, 2); const blob = new Blob([data], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `image_${imageInfo.imageNumber}_page_${imageInfo.pageNumber}.json`; a.click(); URL.revokeObjectURL(url); this.showStatus(`Exported image ${imageInfo.imageNumber} data`, 'success'); } }
        ];
        let menuHTML = '';
        for (const option of menuOptions) { if (option.type === 'header') menuHTML += `<div class="context-menu-header">${option.label}</div>`; else if (option.type === 'divider') menuHTML += '<div class="context-menu-divider"></div>'; else { const className = option.className ? ` ${option.className}` : ''; menuHTML += `\n<div class="context-menu-item${className}" data-action="${option.label}">\n<span class="context-menu-icon">${option.icon || ''}</span>\n<span>${option.label}</span>\n</div>`; } }
        this.contextMenu.innerHTML = menuHTML;
        const menuItems = this.contextMenu.querySelectorAll('.context-menu-item');
        menuItems.forEach((item, index) => { const option = menuOptions.filter(opt => opt.type !== 'header' && opt.type !== 'divider')[index]; if (option && option.handler) { item.addEventListener('click', () => { option.handler(); this.hideContextMenu(); }); } });
        let menuX = event.clientX; let menuY = event.clientY;
        if (menuX + 200 > window.innerWidth) menuX = window.innerWidth - 200;
        if (menuY + 200 > window.innerHeight) menuY = window.innerHeight - 200;
        this.contextMenu.style.left = menuX + 'px';
        this.contextMenu.style.top = menuY + 'px';
        this.contextMenu.classList.add('visible');
    }

    showTableContextMenu(event, tableInfo) {
        const menuOptions = [
            { type: 'header', label: `Table #${tableInfo.tableNumber}` },
            { label: 'Copy Table Info', icon: '📋', handler: () => { const info = `Table #${tableInfo.tableNumber} (${tableInfo.rows}×${tableInfo.columns}) - Page ${tableInfo.pageNumber}`; navigator.clipboard.writeText(info); this.showStatus(`Copied table info: ${info}`, 'success'); } },
            { label: 'Copy Coordinates', icon: '📍', handler: () => { const coords = `PDF: (${tableInfo.coordinates.pdfX.toFixed(2)}, ${tableInfo.coordinates.pdfY.toFixed(2)})`; navigator.clipboard.writeText(coords); this.showStatus('Copied table coordinates', 'success'); } },
            { label: 'Copy Structure', icon: '🔢', handler: () => { const structure = `${tableInfo.rows} rows × ${tableInfo.columns} columns (${tableInfo.cellCount} cells)`; navigator.clipboard.writeText(structure); this.showStatus('Copied table structure', 'success'); } },
            { type: 'divider' },
            { label: 'Table Properties', icon: 'ℹ️', handler: () => { const props = `Table Properties:\n\nTable Number: ${tableInfo.tableNumber}\nPage: ${tableInfo.pageNumber}\nStructure: ${tableInfo.rows} rows × ${tableInfo.columns} columns\nTotal Cells: ${tableInfo.cellCount}\nPDF Coordinates: (${tableInfo.coordinates.pdfX.toFixed(2)}, ${tableInfo.coordinates.pdfY.toFixed(2)})\nCanvas Coordinates: (${tableInfo.coordinates.canvasX.toFixed(0)}, ${tableInfo.coordinates.canvasY.toFixed(0)})\nDimensions: ${tableInfo.bounds.width.toFixed(1)} × ${tableInfo.bounds.height.toFixed(1)} units`; alert(props); } },
            { label: 'Export Table Data', icon: '💾', handler: () => { const data = JSON.stringify(tableInfo, null, 2); const blob = new Blob([data], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `table_${tableInfo.tableNumber}_page_${tableInfo.pageNumber}.json`; a.click(); URL.revokeObjectURL(url); this.showStatus(`Exported table ${tableInfo.tableNumber} data`, 'success'); } }
        ];
        this.buildAndShowContextMenu(event, menuOptions);
    }

    showReferenceContextMenu(event, referenceInfo) {
        const menuOptions = [
            { type: 'header', label: `Reference #${referenceInfo.referenceNumber}` },
            { label: 'Copy Reference Text', icon: '📋', handler: () => { navigator.clipboard.writeText(referenceInfo.text); this.showStatus(`Copied reference: ${referenceInfo.text}`, 'success'); } },
            { label: 'Copy Reference Type', icon: '🏷️', handler: () => { navigator.clipboard.writeText(referenceInfo.referenceType); this.showStatus(`Copied reference type: ${referenceInfo.referenceType}`, 'success'); } },
            { label: 'Copy Coordinates', icon: '📍', handler: () => { const coords = `PDF: (${referenceInfo.coordinates.pdfX.toFixed(2)}, ${referenceInfo.coordinates.pdfY.toFixed(2)})`; navigator.clipboard.writeText(coords); this.showStatus('Copied reference coordinates', 'success'); } },
            { type: 'divider' },
            { label: 'Reference Properties', icon: 'ℹ️', handler: () => { const props = `Reference Properties:\n\nReference Number: ${referenceInfo.referenceNumber}\nPage: ${referenceInfo.pageNumber}\nText: "${referenceInfo.text}"\nType: ${referenceInfo.referenceType}\nFont Size: ${referenceInfo.fontSize.toFixed(1)}px\nPDF Coordinates: (${referenceInfo.coordinates.pdfX.toFixed(2)}, ${referenceInfo.coordinates.pdfY.toFixed(2)})\nCanvas Coordinates: (${referenceInfo.coordinates.canvasX.toFixed(0)}, ${referenceInfo.coordinates.canvasY.toFixed(0)})`; alert(props); } },
            { label: 'Export Reference Data', icon: '💾', handler: () => { const data = JSON.stringify(referenceInfo, null, 2); const blob = new Blob([data], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `reference_${referenceInfo.referenceNumber}_page_${referenceInfo.pageNumber}.json`; a.click(); URL.revokeObjectURL(url); this.showStatus(`Exported reference ${referenceInfo.referenceNumber} data`, 'success'); } }
        ];
        this.buildAndShowContextMenu(event, menuOptions);
    }

    buildAndShowContextMenu(event, menuOptions) {
        let menuHTML = '';
        for (const option of menuOptions) {
            if (option.type === 'header') menuHTML += `<div class="context-menu-header">${option.label}</div>`;
            else if (option.type === 'divider') menuHTML += '<div class="context-menu-divider"></div>';
            else { const className = option.className ? ` ${option.className}` : ''; menuHTML += `\n<div class="context-menu-item${className}" data-action="${option.label}">\n<span class="context-menu-icon">${option.icon || ''}</span>\n<span>${option.label}</span>\n</div>`; }
        }
        this.contextMenu.innerHTML = menuHTML;
        const menuItems = this.contextMenu.querySelectorAll('.context-menu-item');
        menuItems.forEach((item, index) => { const option = menuOptions.filter(opt => opt.type !== 'header' && opt.type !== 'divider')[index]; if (option && option.handler) { item.addEventListener('click', () => { option.handler(); this.hideContextMenu(); }); } });
        let menuX = event.clientX; let menuY = event.clientY;
        if (menuX + 200 > window.innerWidth) menuX = window.innerWidth - 200;
        if (menuY + 200 > window.innerHeight) menuY = window.innerHeight - 200;
        this.contextMenu.style.left = menuX + 'px';
        this.contextMenu.style.top = menuY + 'px';
        this.contextMenu.classList.add('visible');
    }

    hideContextMenu() { this.contextMenu.classList.remove('visible'); this.currentClickedElement = null; }

    handleMouseMove(event) {
        if (!this.pdfDoc) return;
        const rect = this.overlayCanvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (this.overlayCanvas.width / rect.width);
        const y = (event.clientY - rect.top) * (this.overlayCanvas.height / rect.height);

        // Clear previous dynamic highlights
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

        // Draw persistent overlays first (e.g., line spacing mismatches)
        if (this.lineSpacingEnabled) this.drawLineSpacingOverlay();

        // If an existing selection exists, keep it visible
        if (this.selectionMode && this.selectionRect && !this.isSelecting) {
            this.drawSelectionRect(this.selectionRect);
        }

        // If selecting, draw selection rectangle and skip hover highlights
        if (this.selectionMode && this.isSelecting && this.selectionStart) {
            const rectCanvas = this.normalizeRect(this.selectionStart.x, this.selectionStart.y, x, y);
            this.selectionRect = rectCanvas;
            this.drawSelectionRect(rectCanvas);
            this.overlayCanvas.style.cursor = 'crosshair';
            return;
        }

        const wordInfo = this.getWordAtPosition(x, y);
        const imageInfo = this.getImageAtPosition(x, y);
        let foundElement = null;
        if (this.geometryData) {
            const pageIndex = this.currentPage - 1;
            const pageGeometry = this.geometryData.pages.find(p => p.index === pageIndex);
            if (pageGeometry) {
                for (const element of pageGeometry.elements) {
                    if (this.isPointInElement(x, y, element)) { foundElement = element; break; }
                }
            }
        }

        if (imageInfo) { this.highlightImage(imageInfo); this.overlayCanvas.style.cursor = 'crosshair'; }
        else if (wordInfo) { this.highlightWord(wordInfo); this.overlayCanvas.style.cursor = 'text'; }
        else if (foundElement) { this.highlightElement(foundElement); this.overlayCanvas.style.cursor = 'pointer'; }
        else { this.overlayCanvas.style.cursor = 'default'; }

        // Hover tooltips disabled for coordinates per new requirement (retain highlight only)
        if (this.tooltipMode === 'hover' && !this.tooltipPinned) {
            // Line spacing hover tooltip (supersedes other types if lineSpacing enabled)
            let showed = false;
            if (this.lineSpacingEnabled) {
                const line = this.getLineAtCanvasPosition(x, y);
                if (line) {
                    const median = this.lineSpacingMedian || 0;
                    const spacing = line.spacingAbove || 0;
                    const deviation = median ? Math.abs(spacing - median)/median : 0;
                    const tooltip = document.getElementById('tooltip');
                    let html = `<strong>Line ${line.number}</strong><br>`;
                    if (line.spacingAbove) {
                        html += `Spacing: ${spacing.toFixed(2)}`;
                        if (median) html += ` (Δ ${Math.round(deviation*100)}%)`;
                        html += '<br>';
                    } else {
                        html += 'First line (no spacing above)<br>';
                    }
                    html += `Words: ${line.fragments ? line.fragments.map(f=>f.text).join(' | ') : ''}`;
                    tooltip.innerHTML = html;
                    // position
                    let tooltipX = event.clientX + 12;
                    let tooltipY = event.clientY + 12;
                    if (tooltipX + 260 > window.innerWidth) tooltipX = window.innerWidth - 270;
                    if (tooltipY + 140 > window.innerHeight) tooltipY = window.innerHeight - 150;
                    tooltip.className = 'info-tooltip visible';
                    tooltip.style.left = tooltipX + 'px';
                    tooltip.style.top = tooltipY + 'px';
                    showed = true;
                }
            }
            if (!showed) this.hideTooltip();
        }
    }

    handleMouseLeave() {
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
        this.currentWord = null;
        if (!this.tooltipPinned && this.tooltipMode === 'hover') { this.hideTooltip(); }
        this.overlayCanvas.style.cursor = 'default';
        // Cancel active selection on leave
        if (this.selectionMode && this.isSelecting) {
            this.isSelecting = false;
            this.selectionStart = null;
            this.selectionRect = null;
        }
    }

    getElementQuads(element) {
        if (!element) return [];
        const hasPara = element.paragraphQuad && Array.isArray(element.paragraphQuad);
        const hasLines = Array.isArray(element.quads);
        if (this.useParagraphQuad && hasPara) return [element.paragraphQuad];
        if (hasLines) return element.quads;
        if (hasPara) return [element.paragraphQuad];
        return [];
    }

    isPointInElement(x, y, element) {
        const quads = this.getElementQuads(element);
        if (!quads.length) return false;
        for (const quad of quads) { if (this.isPointInQuad(x, y, quad)) return true; }
        return false;
    }

    normalizeRect(x1, y1, x2, y2) {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);
        return { left, right, top, bottom };
    }

    drawSelectionRect(rect) {
        if (!rect) return;
        this.overlayCtx.fillStyle = 'rgba(231, 76, 60, 0.15)';
        this.overlayCtx.strokeStyle = 'rgba(231, 76, 60, 0.9)';
        this.overlayCtx.lineWidth = 1.5;
        this.overlayCtx.beginPath();
        this.overlayCtx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
        this.overlayCtx.fill();
        this.overlayCtx.stroke();
    }

    isPointInQuad(x, y, quad) {
        const points = [];
        for (let i = 0; i < 8; i += 2) { points.push({ x: quad[i] * this.scale, y: (this.canvas.height - quad[i + 1] * this.scale) }); }
        let inside = false;
        for (let i = 0, j = 3; i < 4; j = i++) {
            const xi = points[i].x, yi = points[i].y;
            const xj = points[j].x, yj = points[j].y;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    highlightElement(element) {
        const primaryQuads = this.getElementQuads(element);
        if (!primaryQuads.length) return;
        // Draw primary quads (current mode)
        this.overlayCtx.fillStyle = 'rgba(52, 152, 219, 0.2)';
        this.overlayCtx.strokeStyle = 'rgba(52, 152, 219, 0.8)';
        this.overlayCtx.lineWidth = 2;
        for (const quad of primaryQuads) {
            this.overlayCtx.beginPath();
            const x1 = quad[0] * this.scale;
            const y1 = this.canvas.height - quad[1] * this.scale;
            this.overlayCtx.moveTo(x1, y1);
            for (let i = 2; i < 8; i += 2) {
                const x = quad[i] * this.scale;
                const y = this.canvas.height - quad[i + 1] * this.scale;
                this.overlayCtx.lineTo(x, y);
            }
            this.overlayCtx.closePath();
            this.overlayCtx.fill();
            this.overlayCtx.stroke();
        }
        // If debug enabled, overlay the alternative representation
        if (this.debugQuadOverlay) {
            const lineQuads = Array.isArray(element.quads) ? element.quads : [];
            const paraQuad = (element.paragraphQuad && Array.isArray(element.paragraphQuad)) ? [element.paragraphQuad] : [];
            const altQuads = this.useParagraphQuad ? lineQuads : paraQuad;
            if (altQuads && altQuads.length) {
                this.overlayCtx.fillStyle = this.useParagraphQuad ? 'rgba(46, 204, 113, 0.2)' : 'rgba(231, 76, 60, 0.15)';
                this.overlayCtx.strokeStyle = this.useParagraphQuad ? 'rgba(46, 204, 113, 0.8)' : 'rgba(231, 76, 60, 0.85)';
                this.overlayCtx.lineWidth = 2;
                for (const quad of altQuads) {
                    this.overlayCtx.beginPath();
                    const x1 = quad[0] * this.scale;
                    const y1 = this.canvas.height - quad[1] * this.scale;
                    this.overlayCtx.moveTo(x1, y1);
                    for (let i = 2; i < 8; i += 2) {
                        const x = quad[i] * this.scale;
                        const y = this.canvas.height - quad[i + 1] * this.scale;
                        this.overlayCtx.lineTo(x, y);
                    }
                    this.overlayCtx.closePath();
                    this.overlayCtx.stroke();
                }
            }
        }
    }

    highlightWord(wordInfo) {
        if (!wordInfo) return;
        this.overlayCtx.fillStyle = 'rgba(255, 193, 7, 0.3)';
        this.overlayCtx.strokeStyle = 'rgba(255, 193, 7, 0.8)';
        this.overlayCtx.lineWidth = 1;
        this.overlayCtx.beginPath();
        this.overlayCtx.rect(wordInfo.bounds.left, wordInfo.bounds.top, wordInfo.bounds.right - wordInfo.bounds.left, wordInfo.bounds.bottom - wordInfo.bounds.top);
        this.overlayCtx.fill();
        this.overlayCtx.stroke();
        const charWidth = (wordInfo.bounds.right - wordInfo.bounds.left) / wordInfo.word.length;
        const charX = wordInfo.bounds.left + (charWidth * wordInfo.charIndex);
        this.overlayCtx.fillStyle = 'rgba(220, 53, 69, 0.6)';
        this.overlayCtx.fillRect(charX, wordInfo.bounds.top, Math.max(charWidth, 2), wordInfo.bounds.bottom - wordInfo.bounds.top);
    }

    highlightImage(imageInfo) {
        if (!imageInfo) return;
        this.overlayCtx.fillStyle = 'rgba(40, 167, 69, 0.2)';
        this.overlayCtx.strokeStyle = 'rgba(40, 167, 69, 0.8)';
        this.overlayCtx.lineWidth = 3;
        this.overlayCtx.beginPath();
        this.overlayCtx.rect(imageInfo.canvasBounds.left, imageInfo.canvasBounds.top, imageInfo.canvasBounds.right - imageInfo.canvasBounds.left, imageInfo.canvasBounds.bottom - imageInfo.canvasBounds.top);
        this.overlayCtx.fill();
        this.overlayCtx.stroke();
        const centerX = (imageInfo.canvasBounds.left + imageInfo.canvasBounds.right) / 2;
        const centerY = (imageInfo.canvasBounds.top + imageInfo.canvasBounds.bottom) / 2;
        this.overlayCtx.fillStyle = 'rgba(40, 167, 69, 0.9)';
        this.overlayCtx.beginPath();
        this.overlayCtx.arc(centerX, centerY, 20, 0, 2 * Math.PI);
        this.overlayCtx.fill();
        this.overlayCtx.fillStyle = 'white';
        this.overlayCtx.font = 'bold 14px Arial';
        this.overlayCtx.textAlign = 'center';
        this.overlayCtx.textBaseline = 'middle';
        this.overlayCtx.fillText(imageInfo.imageNumber.toString(), centerX, centerY);
    }

    // Removed highlightTable / highlightReference and related label helpers

    showTooltip(event, element) {
        const tooltip = document.getElementById('tooltip');
        tooltip.innerHTML = `\n<strong>Page:</strong> ${this.currentPage}<br>\n<strong>ID:</strong> ${element.id || 'N/A'}<br>\n<strong>Role:</strong> ${element.role || 'N/A'}\n${element.lang ? `<br><strong>Language:</strong> ${element.lang}` : ''}\n`;
        let tooltipX = event.clientX - 100;
        let tooltipY = event.clientY - 80;
        let isAbove = true;
        if (tooltipX + 200 > window.innerWidth) tooltipX = window.innerWidth - 200;
        if (tooltipX < 10) tooltipX = 10;
        if (tooltipY < 10) { tooltipY = event.clientY + 15; isAbove = false; } else if (tooltipY + 100 > window.innerHeight) { tooltipY = window.innerHeight - 110; }
        tooltip.className = `info-tooltip visible ${isAbove ? '' : 'above'}`;
        tooltip.style.left = tooltipX + 'px';
        tooltip.style.top = tooltipY + 'px';
    }

    handleMouseDown(event) {
        if (!this.selectionMode) return;
        if (event.button !== 0) return; // left button only
        const rect = this.overlayCanvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (this.overlayCanvas.width / rect.width);
        const y = (event.clientY - rect.top) * (this.overlayCanvas.height / rect.height);
        this.isSelecting = true;
        this.selectionStart = { x, y };
        this.selectionRect = null;
    }

    handleMouseUp(event) {
        if (!this.selectionMode || !this.isSelecting || !this.selectionStart) return;
        const rect = this.overlayCanvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (this.overlayCanvas.width / rect.width);
        const y = (event.clientY - rect.top) * (this.overlayCanvas.height / rect.height);
        const rectCanvas = this.normalizeRect(this.selectionStart.x, this.selectionStart.y, x, y);
        this.isSelecting = false;
        this.selectionStart = null;
        this.selectionRect = rectCanvas;
        // Convert canvas rect to PDF units
        const pdfRect = {
            left: rectCanvas.left / this.scale,
            right: rectCanvas.right / this.scale,
            // canvas Y origin at top -> PDF Y = (canvas.height - y)/scale
            top: (this.canvas.height - rectCanvas.top) / this.scale,
            bottom: (this.canvas.height - rectCanvas.bottom) / this.scale
        };
        const selection = this.extractTextInPdfRect(pdfRect);
        if (selection && selection.text) {
            // Try to copy to clipboard
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(selection.text).then(() => {
                    this.showStatus(`Copied ${selection.wordCount} words from ${selection.lineCount} lines`, 'success');
                }).catch(() => {
                    this.showStatus(`Selected ${selection.wordCount} words from ${selection.lineCount} lines`, 'info');
                });
            } else {
                this.showStatus(`Selected ${selection.wordCount} words from ${selection.lineCount} lines`, 'info');
            }
        } else {
            this.showStatus('No text found in selection', 'info');
        }
        // Redraw to keep selection rectangle visible over any overlays
        this.redrawCurrentOverlay();
        this.drawSelectionRect(rectCanvas);
    }

    extractTextInPdfRect(pdfRect) {
        if (!this.textItems || !this.textItems.length) return { text: '', lineCount: 0, wordCount: 0 };
        // Collect items that intersect with the rect
        const items = [];
        for (const item of this.textItems) {
            const itemLeft = item.x;
            const itemRight = item.x + item.width;
            const itemBottom = item.y - item.height * 0.2;
            const itemTop = item.y + item.height * 0.8;
            const intersects = !(itemRight < pdfRect.left || itemLeft > pdfRect.right || itemTop < pdfRect.bottom || itemBottom > pdfRect.top);
            if (intersects) items.push(item);
        }
        if (!items.length) return { text: '', lineCount: 0, wordCount: 0 };
        // Group by baseline (y) with tolerance
        const tolerance = 4;
        const lines = [];
        for (const it of items) {
            let line = lines.find(l => Math.abs(l.y - it.y) <= tolerance);
            if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
            line.items.push(it);
        }
        // Sort lines visually top->bottom (PDF y desc)
        lines.sort((a,b)=> b.y - a.y);
        // Build text with items sorted by x
        const texts = [];
        let wordCount = 0;
        for (const line of lines) {
            line.items.sort((a,b)=> a.x - b.x);
            const lineText = line.items.map(i=> i.str).join(' ');
            const words = line.items.length;
            wordCount += words;
            texts.push(lineText);
        }
        return { text: texts.join('\n'), lineCount: lines.length, wordCount };
    }

    showWordTooltip(event, wordInfo, element) {
        const tooltip = document.getElementById('tooltip');
        let tooltipContent = `\n<strong>Page:</strong> ${this.currentPage}<br>\n<strong>Word:</strong> "${wordInfo.word}"<br>\n<strong>Character:</strong> "${wordInfo.word[wordInfo.charIndex]}" (${wordInfo.charIndex + 1}/${wordInfo.word.length})<br>\n<strong>Coordinates:</strong><br>\n&nbsp;&nbsp;PDF: (${wordInfo.coordinates.pdfX.toFixed(1)}, ${wordInfo.coordinates.pdfY.toFixed(1)})<br>\n&nbsp;&nbsp;Canvas: (${wordInfo.coordinates.canvasX.toFixed(0)}, ${wordInfo.coordinates.canvasY.toFixed(0)})<br>\n<strong>Font Size:</strong> ${wordInfo.fontSize.toFixed(1)}px\n`;
        if (element) { tooltipContent += `<br><br><strong>Element ID:</strong> ${element.id || 'N/A'}<br>\n<strong>Role:</strong> ${element.role || 'N/A'}`; }
        tooltip.innerHTML = tooltipContent;
        let tooltipX = event.clientX - 125; let tooltipY = event.clientY - 100; let isAbove = true;
        if (tooltipX < 10) tooltipX = 10; else if (tooltipX + 250 > window.innerWidth) tooltipX = window.innerWidth - 260;
        if (tooltipY < 10) { tooltipY = event.clientY + 15; isAbove = false; } else if (tooltipY + 150 > window.innerHeight) tooltipY = window.innerHeight - 160;
        tooltip.className = `info-tooltip visible ${isAbove ? '' : 'above'}`;
        tooltip.style.left = tooltipX + 'px'; tooltip.style.top = tooltipY + 'px';
    }

    showImageTooltip(event, imageInfo, element) {
        const tooltip = document.getElementById('tooltip');
        let tooltipContent = `\n<strong>Page:</strong> ${this.currentPage}<br>\n<strong>Type:</strong> Image #${imageInfo.imageNumber}<br>\n<strong>Coordinates:</strong><br>\n&nbsp;&nbsp;PDF: (${imageInfo.coordinates.pdfX.toFixed(1)}, ${imageInfo.coordinates.pdfY.toFixed(1)})<br>\n&nbsp;&nbsp;Canvas: (${imageInfo.coordinates.canvasX.toFixed(0)}, ${imageInfo.coordinates.canvasY.toFixed(0)})<br>\n<strong>Dimensions:</strong><br>\n&nbsp;&nbsp;Width: ${imageInfo.bounds.width.toFixed(1)} units<br>\n&nbsp;&nbsp;Height: ${imageInfo.bounds.height.toFixed(1)} units\n`;
        if (element) { tooltipContent += `<br><br><strong>Element ID:</strong> ${element.id || 'N/A'}<br>\n<strong>Role:</strong> ${element.role || 'N/A'}`; }
        tooltip.innerHTML = tooltipContent;
        let tooltipX = event.clientX - 140; let tooltipY = event.clientY - 110; let isAbove = true;
        if (tooltipX < 10) tooltipX = 10; else if (tooltipX + 280 > window.innerWidth) tooltipX = window.innerWidth - 290;
        if (tooltipY < 10) { tooltipY = event.clientY + 15; isAbove = false; } else if (tooltipY + 180 > window.innerHeight) tooltipY = window.innerHeight - 190;
        tooltip.className = `info-tooltip visible ${isAbove ? '' : 'above'}`;
        tooltip.style.left = tooltipX + 'px'; tooltip.style.top = tooltipY + 'px';
    }

    showTableTooltip(event, tableInfo, element) {
        // Deprecated (table tooltips removed)
    }

    showReferenceTooltip(event, referenceInfo, element) {
        // Deprecated (reference tooltips removed)
    }

    hideTooltip() {
        const tooltip = document.getElementById('tooltip');
        tooltip.className = 'info-tooltip';
        // When explicitly hiding (outside click / ESC), unpin
        if (this.tooltipPinned && this.tooltipMode === 'click') this.tooltipPinned = false;
    }

    /* ================= Line Spacing Analysis ================= */
    computeLineSpacingMetrics() {
        if (!this.textItems.length) return;
        // Group items by baseline (y) with tolerance
        const tolerance = 4; // PDF units
        const lines = [];
        for (const item of this.textItems) {
            let line = lines.find(l => Math.abs(l.y - item.y) <= tolerance);
            if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
            line.items.push(item);
        }
        // Sort baseline descending (PDF y increases upward)
        lines.sort((a,b)=> b.y - a.y);
        // Compute spacing and boxes
        const spacings = [];
        for (let i=1;i<lines.length;i++) {
            const prev = lines[i-1];
            const curr = lines[i];
            const gap = prev.y - curr.y;
            curr.spacingAbove = gap;
            if (gap > 0) spacings.push(gap);
        }
        const median = this.median(spacings);
        this.lineSpacingMedian = median || 0;
        const threshold = this.lineSpacingThresholdPct / 100;
        // Determine boxes
        for (const line of lines) {
            line.items.sort((a,b)=> a.x - b.x);
            const left = Math.min(...line.items.map(i=>i.x));
            const right = Math.max(...line.items.map(i=>i.x + i.width));
            const maxFont = Math.max(...line.items.map(i=>i.fontSize));
            const top = line.y + maxFont * 0.8;
            const bottom = line.y - maxFont * 0.2;
            line.box = { left, right, top, bottom, fontSize:maxFont };
            if (!line.spacingAbove) { line.mismatch = false; continue; }
            const deviation = median ? Math.abs(line.spacingAbove - median)/median : 0;
            line.mismatch = deviation > threshold;
        }
        this.lineGroups = lines;
        this.lineMismatches = lines.filter(l=> l.mismatch);
        this.drawLineSpacingOverlay();
    }

    drawLineSpacingOverlay() {
        if (!this.lineSpacingEnabled || !this.lineGroups.length) return;
        const median = this.lineSpacingMedian || 0;
        // Draw all lines with lighter background; emphasize mismatches
        for (const line of this.lineGroups) {
            const box = line.box;
            if (!box) continue;
            const canvasLeft = box.left * this.scale;
            const canvasRight = box.right * this.scale;
            const canvasTop = (this.canvas.height / this.scale - box.top) * this.scale;
            const canvasBottom = (this.canvas.height / this.scale - box.bottom) * this.scale;
            const height = canvasBottom - canvasTop;
            const spacing = line.spacingAbove || 0;
            const deviation = median ? Math.abs(spacing - median)/median : 0;
            const isMismatch = line.mismatch;
            // Background color scales with mismatch
            if (spacing) {
                if (isMismatch) {
                    this.overlayCtx.fillStyle = 'rgba(231,76,60,0.30)';
                    this.overlayCtx.strokeStyle = 'rgba(231,76,60,0.85)';
                } else {
                    this.overlayCtx.fillStyle = 'rgba(52,152,219,0.12)';
                    this.overlayCtx.strokeStyle = 'rgba(52,152,219,0.45)';
                }
                this.overlayCtx.lineWidth = isMismatch ? 2 : 1;
                this.overlayCtx.beginPath();
                this.overlayCtx.rect(canvasLeft, canvasTop, canvasRight - canvasLeft, height);
                this.overlayCtx.fill();
                this.overlayCtx.stroke();
            }
            // Removed always-on labels; now shown via hover tooltip
        }
        // Draw median reference pill
        if (median) {
            const text = `Median: ${median.toFixed(1)}`;
            this.overlayCtx.font = '11px Arial';
            const paddingX = 8; const paddingY = 4;
            const metrics = this.overlayCtx.measureText(text);
            const w = metrics.width + paddingX*2;
            const h = 18;
            const x = 10; const y = 10;
            this.overlayCtx.fillStyle = 'rgba(0,0,0,0.55)';
            this.overlayCtx.strokeStyle = 'rgba(255,255,255,0.35)';
            this.overlayCtx.lineWidth = 1;
            this.overlayCtx.beginPath();
            this.overlayCtx.roundRect(x, y, w, h, 9);
            this.overlayCtx.fill();
            this.overlayCtx.stroke();
            this.overlayCtx.fillStyle = '#ecf0f1';
            this.overlayCtx.textBaseline = 'middle';
            this.overlayCtx.fillText(text, x + paddingX, y + h/2 + 1);
        }
    }

    getLineAtCanvasPosition(canvasX, canvasY) {
        if (!this.lineSpacingEnabled || !this.lineGroups.length) return null;
        // Convert canvasY back to PDF y for baseline comparison
        const pdfY = (this.canvas.height - canvasY) / this.scale;
        // Find line whose vertical box contains the canvas point
        for (const line of this.lineGroups) {
            const box = line.box; if (!box) continue;
            const topPDF = box.top; // higher value
            const bottomPDF = box.bottom; // lower value
            if (pdfY <= topPDF && pdfY >= bottomPDF) return line;
        }
        return null;
    }

    redrawCurrentOverlay() {
        this.overlayCtx.clearRect(0,0,this.overlayCanvas.width,this.overlayCanvas.height);
        if (this.lineSpacingEnabled) this.drawLineSpacingOverlay();
    }

    median(arr) {
        if (!arr || !arr.length) return 0;
        const sorted = [...arr].sort((a,b)=>a-b);
        const mid = Math.floor(sorted.length/2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
    }
}

document.addEventListener('DOMContentLoaded', () => { new PDFHighlightViewer(); });
