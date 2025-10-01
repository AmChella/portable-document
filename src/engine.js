/**
 * XML to Text Transformation Engine (Functional Style)
 *
 * This script provides a comprehensive pipeline for converting XML documents into any text-based format (HTML, TeX, etc.)
 * based on a declarative template file. The transformation is TEMPLATE-DRIVEN.
 *
 * Core Principles:
 * 1. Template-Ordered Output: The output structure is determined by the template's structure.
 * 2. Explicit Processing: An XML node is only processed if it is explicitly selected by a template.
 * 3. Controlled Delegation: Child nodes are processed only when a template explicitly uses `[[...]]`, `<apply-template>`, or `<apply-children/>`.
 *
 * New Features for TeX Transformation:
 * - Automatic Content Escaping: Content is escaped by default for the target format.
 * - Smart Whitespace Control: Readable templates produce clean, correct output.
 * - Processing Instruction (PI) Support: A dedicated system for handling PIs like `<?tex-kern ...?>`.
 *
 * Tech Stack:
 * - Node.js, peggy, xmldom, nanoid (via dynamic import)
 */

const fs = require('fs');
const path = require('path');
const peggy = require('peggy');
const { performance } = require('perf_hooks');
const { DOMParser, XMLSerializer } = require('xmldom');

// --- 1. Peggy Parsers ---

/**
 * Creates a parser for CSS-like selectors.
 * @returns {peggy.Parser} The generated Peggy parser.
 */
function createSelectorParser() {
    const grammar = `
        start = selector

        selector = first_combinator:combinator? first_part:part rest:(c:combinator p:part)* {
            const parts = [first_part];
            first_part.combinator = first_combinator || ' '; 
            for (const r of rest) {
                const combinator = r[0]; const part = r[1];
                part.combinator = combinator;
                parts.push(part);
            }
            return { parts: parts, hasLeadingCombinator: !!first_combinator };
        }

        combinator = ws* c:">" ws* { return c; } / ws+ { return " "; }

        part = tag:("*" / tag_selector)? attrs:attribute_selector* &{ return tag || attrs.length > 0; } {
            const result = { type: 'selector_part', tag: tag || '*', attributes: attrs };
            let specificity = [0, 0, 0];
            if (result.tag !== '*') specificity[0] = 1;
            result.attributes.forEach(attr => {
                specificity[1]++;
                if (attr.value !== undefined) specificity[2]++;
            });
            result.specificity = specificity;
            return result;
        }
        
        tag_selector = name:[a-zA-Z0-9_\\-:]+ { return name.join(''); }

        attribute_selector = "[" ws* name:[a-zA-Z0-9_\\-:]+ ws* val:attribute_value? ws* "]" {
            const attr = { name: name.join('') };
            if (val !== null && val !== undefined) { attr.value = val; }
            return attr;
        }

        attribute_value = "=" ws* val:(double_quoted_value / single_quoted_value / unquoted_value) { return val; }
        double_quoted_value = '"' chars:[^"]* '"' { return chars.join(''); }
        single_quoted_value = "'" chars:[^']* "'" { return chars.join(''); }
        unquoted_value = chars:[a-zA-Z0-9_\\-]+ { return chars.join(''); }
        ws = [ \\t\\n\\r]
    `;
    return peggy.generate(grammar);
}

/**
 * Creates a parser for template placeholders and filter pipelines.
 * @returns {peggy.Parser} The generated Peggy parser.
 */
function createPlaceholderParser() {
    const grammar = `
        start = placeholder
        placeholder = "[[" ws* content:content ws* "]]" { return content; }

        content
          = selector:selector_text ws* ":" ws* placeholder:simple_placeholder { return { selector: selector, ...placeholder }; }
          / placeholder:simple_placeholder { return placeholder; }

        simple_placeholder
          = target:("..." / "." / "self" / "target" / "data" / attribute_placeholder / other_placeholder) ws* pipeline:pipeline? {
              return { target: target, filters: pipeline || [] };
            }
        
        attribute_placeholder = "@" name:[a-zA-Z0-9_\\-:]+ { return { type: 'attribute', name: name.join('') }; }
        other_placeholder = name:[a-zA-Z0-9_\\-:]+ { return name.join(''); }

        pipeline = "|" ws* first:filter_name ws* rest:(ws* "|" ws* f:filter_name)* {
            return [first, ...rest.map(r => r[3])];
        }

        filter_name = chars:[a-zA-Z0-9_]+ { return chars.join(''); }
        selector_text = text:$( (!(ws* ":" ws* ("." / "self" / "@")) . )* ) { return text.trim(); }
        ws = [ \\t\\n\\r]+
    `;
    return peggy.generate(grammar);
}

/**
 * [NEW] Creates a parser for Processing Instruction (PI) pseudo-attributes.
 * This is a more readable and maintainable alternative to a complex regex.
 * @returns {peggy.Parser} The generated Peggy parser.
 */
function createPiAttributeParser() {
    const grammar = `
        start = attrs:attributes? { return attrs || {}; }

        attributes = first:attribute rest:(ws+ a:attribute)* {
            const result = { [first.key]: first.value };
            rest.forEach(item => {
                result[item[1].key] = item[1].value;
            });
            return result;
        }

        attribute = key:key ws* "=" ws* value:value { return { key, value }; }

        key = chars:[a-zA-Z0-9_:-]+ { return chars.join(''); }

        value = double_quoted_value / single_quoted_value / unquoted_value

        double_quoted_value = '"' chars:[^"]* '"' { return chars.join(''); }
        single_quoted_value = "'" chars:[^']* "'" { return chars.join(''); }
        unquoted_value = chars:[^'"\\s]+ { return chars.join(''); }

        ws = [ \\t\\n\\r]+
    `;
    return peggy.generate(grammar);
}


const selectorParser = createSelectorParser();
const placeholderParser = createPlaceholderParser();
const piAttributeParser = createPiAttributeParser();


// --- 2. Core Modules / Functions ---

/**
 * [NEW] Escapes a string for safe inclusion in a TeX document.
 * @param {string} str The input string.
 * @returns {string} The escaped string.
 */
function _escapeTex(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/\\/g, '\\textbackslash{}')
        .replace(/~/g, '\\textasciitilde{}')
        .replace(/\^/g, '\\textasciicircum{}')
        .replace(/&/g, '\\&')
        .replace(/%/g, '\\%')
        .replace(/\$/g, '\\$')
        .replace(/#/g, '\\#')
        .replace(/_/g, '\\_')
        .replace(/{/g, '\\{')
        .replace(/}/g, '\\}');
}

/**
 * Compares the specificity of two parsed selector parts.
 * @param {object} a - Parsed selector part A.
 * @param {object} b - Parsed selector part B.
 * @returns {number} Positive if A is more specific, negative if B is, 0 if equal.
 */
function compareSpecificity(a, b) {
    const specA = a.specificity;
    const specB = b.specificity;
    if (specA[2] !== specB[2]) return specA[2] - specB[2];
    if (specA[1] !== specB[1]) return specA[1] - specB[1];
    if (specA[0] !== specB[0]) return specA[0] - specB[0];
    return 0;
}

// --- Helper functions ---

/**
 * [MODIFIED] Recursively cleans a template DOM with smart whitespace control.
 * It removes comment nodes and applies smart trimming to text nodes, unless
 * an ancestor has `xml:space="preserve"`.
 * @param {Node} node The DOM node to clean.
 * @param {boolean} preserveSpace Whether to preserve whitespace for this node and its children.
 */
function _cleanTemplateDOM(node, preserveSpace = false) {
    const shouldPreserve = preserveSpace || (node.nodeType === 1 && node.getAttribute('xml:space') === 'preserve');

    for (let i = node.childNodes.length - 1; i >= 0; i--) {
        const child = node.childNodes[i];

        if (child.nodeType === 8) { // Node.COMMENT_NODE
            node.removeChild(child);
        } else if (child.nodeType === 3 && !shouldPreserve) { // Node.TEXT_NODE
            const originalValue = child.nodeValue;
            
            // First, apply normal whitespace cleaning (trim and collapse whitespace)
            const trimmedValue = originalValue.trim();
            if (trimmedValue === '') {
                node.removeChild(child);
            } else {
                // Collapse multiple whitespace chars into a single space
                let cleanedValue = trimmedValue.replace(/\s+/g, ' ');
                
                // THEN convert literal \n sequences to actual newlines
                cleanedValue = cleanedValue.replace(/\\n/g, '\n');
                cleanedValue = cleanedValue.replace(/\n /g, '\n');
                
                child.nodeValue = cleanedValue;
            }
        } else if (child.nodeType === 1) { // Node.ELEMENT_NODE
            _cleanTemplateDOM(child, shouldPreserve);
        }
    }
}


/**
 * Generates a simple CSS-like path for an XML node, for logging.
 * @param {Node} node The XML node.
 * @returns {string} A path string.
 */
function _getNodePath(node) {
    const path = [];
    let current = node;
    while (current && current.nodeType === 1) {
        path.unshift(current.tagName);
        current = current.parentNode;
    }
    return path.join(' > ');
}

/**
 * Checks if a single XML node matches a single parsed selector part.
 * @param {Node} xmlNode - The XML element to check.
 * @param {object} selectorPart - A parsed selector object.
 * @returns {boolean} True if the node matches.
 */
function _matches(xmlNode, selectorPart) {
    if (xmlNode.nodeType !== 1) return false;
    
    if (selectorPart.tag !== '*' && xmlNode.tagName.toLowerCase() !== selectorPart.tag.toLowerCase()) {
        return false;
    }

    for (const selectorAttr of selectorPart.attributes) {
        let attributeFound = false;
        for (let i = 0; i < xmlNode.attributes.length; i++) {
            const nodeAttr = xmlNode.attributes[i];
            if (nodeAttr.name.toLowerCase() === selectorAttr.name.toLowerCase()) {
                if (selectorAttr.value === undefined || nodeAttr.value.toLowerCase() === selectorAttr.value.toLowerCase()) {
                    attributeFound = true;
                    break;
                }
            }
        }
        if (!attributeFound) return false;
    }
    return true;
}

/**
 * A helper to get all descendant elements of a node.
 * @param {Node} node The node to start from.
 * @returns {Element[]} An array of all descendant elements.
 */
function _getAllDescendants(node, result = []) {
    for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1) {
            result.push(child);
            _getAllDescendants(child, result);
        }
    }
    return result;
}

/**
 * Selects XML nodes based on a full selector string, relative to a context node.
 * @param {Node} contextNode - The starting point for the selection.
 * @param {string} selector - The full selector string.
 * @returns {Node[]} An array of unique matched nodes.
 */
function _select(contextNode, selector) {
    const parsedResult = selectorParser.parse(selector.trim());
    let contexts = [contextNode];

    for (const part of parsedResult.parts) {
        let newContexts = new Set();
        if (part.combinator === '>') {
            for (const ctx of contexts) {
                for (const child of Array.from(ctx.childNodes).filter(n => n.nodeType === 1)) {
                    if (_matches(child, part)) newContexts.add(child);
                }
            }
        } else { // ' ' (descendant)
            for (const ctx of contexts) {
                const descendants = _getAllDescendants(ctx);
                for (const descendant of descendants) {
                    if (_matches(descendant, part)) newContexts.add(descendant);
                }
            }
        }
        contexts = Array.from(newContexts);
    }
    return contexts;
}

/**
 * Validates if a given XML node matches a full selector path by walking UP the DOM tree.
 * @param {Node} xmlNode - The node to validate.
 * @param {Array<object>} selectorParts - The array of parsed selector parts.
 * @returns {boolean} True if the node is a valid target for the selector.
 */
function _matchesPath(xmlNode, selectorParts) {
    let currentNode = xmlNode;
    for (let i = selectorParts.length - 1; i >= 0; i--) {
        const part = selectorParts[i];
        
        if (i === selectorParts.length - 1) {
            if (!_matches(currentNode, part)) return false;
            continue;
        }

        const combinator = selectorParts[i + 1].combinator;
        let ancestor = currentNode.parentNode;

        if (combinator === '>') {
            if (!ancestor || !_matches(ancestor, part)) return false;
            currentNode = ancestor;
        } else {
            let foundMatch = false;
            while (ancestor && ancestor.nodeType === 1) {
                if (_matches(ancestor, part)) {
                    foundMatch = true;
                    currentNode = ancestor;
                    break;
                }
                ancestor = ancestor.parentNode;
            }
            if (!foundMatch) return false;
        }
    }
    return true;
}


/**
 * Finds the best matching template for a given XML element.
 * @param {Node} xmlNode - The XML node to find a match for.
 * @param {object} engineState - The central state object.
 * @returns {object} The best matching template and selector part.
 */
function _findBestMatch(xmlNode, engineState) {
    let bestMatch = null;
    const tagName = xmlNode.tagName.toLowerCase();
    const candidateTemplates = (engineState.templateCache[tagName] || []).concat(engineState.templateCache['*'] || []);

    for (const template of candidateTemplates) {
        const selector = template.getAttribute('data-xml-selector');
        const parsedResult = selectorParser.parse(selector.trim());
        if (parsedResult.hasLeadingCombinator) continue;
        
        if (_matchesPath(xmlNode, parsedResult.parts)) {
            const lastPart = parsedResult.parts[parsedResult.parts.length - 1];
            if (!bestMatch || compareSpecificity(lastPart, bestMatch.parsedSelector) > 0) {
                bestMatch = { template, parsedSelector: lastPart };
            }
        }
    }
    return { bestMatch };
}

/**
 * [MODIFIED] Resolves a placeholder, applying filters and default escaping.
 * @param {object} engineState - The central state object.
 * @param {Node} xmlNode - The XML node providing context.
 * @param {object} placeholder - The parsed placeholder object.
 * @param {Node} [piNode=null] - The PI node, if processing a PI template.
 * @returns {string} The final, processed string value.
 */
function _resolvePlaceholder(engineState, xmlNode, placeholder, piNode = null) {
    let contextNode = xmlNode;

    if (placeholder.selector) {
        const selectedNodes = _select(xmlNode, placeholder.selector);
        if (selectedNodes.length > 0) {
            selectedNodes.forEach(node => {
                const uuid = node.getAttribute('data-uuid');
                if (uuid) engineState.processedUuids.add(uuid);
            });
            contextNode = selectedNodes[0];
        } else {
            return '';
        }
    }

    let value = ''; // Initialize to prevent errors
    const target = placeholder.target;

    // 1. Determine the raw value based on the target type
    if (typeof target === 'object' && target.type === 'attribute') {
        const attrName = target.name;
        if (piNode) {
            value = (engineState.piDataCache.get(piNode) || {})[attrName] || '';
        } else {
            if (attrName === 'tagName') {
                value = contextNode.tagName;
            } else {
                value = contextNode.getAttribute(attrName) || '';
            }
        }
    } else if (typeof target === 'string') {
        switch (target) {
            case '.':
                if (!piNode) value = contextNode.textContent;
                break;
            case 'self':
                if (!piNode) value = contextNode;
                break;
            case 'data':
                if (piNode) value = piNode.data;
                break;
            case 'target':
                if (piNode) value = piNode.target;
                break;
        }
    }
    
    // 2. Apply filters
    const hasRawFilter = placeholder.filters.includes('raw');
    if (!hasRawFilter && engineState.context.engine?.escapeFn) {
        value = engineState.context.engine.escapeFn(value);
    }
    
    for (const filterName of placeholder.filters) {
        if (filterName === 'raw') continue; // 'raw' is a flag, not a transform
        const filterFn = engineState.filters[filterName];
        if (filterFn) {
            value = filterFn(value, contextNode, engineState.context);
        }
    }
    return typeof value === 'string' ? value : new XMLSerializer().serializeToString(value);
}


/**
 * [REFACTORED] Traverses a cloned template node, filling its placeholders and recursively applying templates.
 * This version uses a unified, simpler logic to handle all placeholders in text nodes.
 * @param {object} engineState - The central state object.
 * @param {Node} xmlContextNode - The XML node that provides the data context.
 * @param {Node} templateClone - The cloned template node to be filled.
 */
function _fillTemplate(engineState, xmlContextNode, templateClone) {
    // Process attributes first
    for (const attr of Array.from(templateClone.attributes || [])) {
        let finalValue = attr.value;
        const placeholders = attr.value.match(/\[\[\s*.*?]]/g);
        if (placeholders) {
            for (const placeholderText of placeholders) {
                try {
                    const parsed = placeholderParser.parse(placeholderText);
                    const resolvedValue = _resolvePlaceholder(engineState, xmlContextNode, parsed);
                    finalValue = finalValue.replace(placeholderText, resolvedValue);
                } catch (e) { /* ignore */ }
            }
            templateClone.setAttribute(attr.name, finalValue);
        }
    }

    // Process child nodes
    const childNodes = Array.from(templateClone.childNodes);
    for (const child of childNodes) {
        if (child.nodeType === 1) { // Element Node
            const tagName = child.tagName.toLowerCase();
            if (tagName === 'apply-children') {
                const fragment = templateClone.ownerDocument.createDocumentFragment();
                for (const xmlChild of Array.from(xmlContextNode.childNodes)) {
                    _processNode(engineState, xmlChild, fragment);
                }
                templateClone.replaceChild(fragment, child);
            } else if (tagName === 'apply-template') {
                const selector = child.getAttribute('data-xml-selector');
                if (selector) {
                    const overrideAttributes = {};
                    for (const attr of Array.from(child.attributes)) {
                        if (attr.name !== 'data-xml-selector') overrideAttributes[attr.name] = attr.value;
                    }
                    const fragment = templateClone.ownerDocument.createDocumentFragment();
                    const matchedXmlNodes = _select(xmlContextNode, selector);
                    for (const matchedXmlNode of matchedXmlNodes) {
                        _processNode(engineState, matchedXmlNode, fragment, overrideAttributes);
                    }
                    templateClone.replaceChild(fragment, child);
                }
            } else {
                _fillTemplate(engineState, xmlContextNode, child);
            }
        } else if (child.nodeType === 3) { // Text Node
            const originalValue = child.nodeValue;
            const placeholderRegex = /\[\[\s*.*?]]/g;
            let match;
            let lastIndex = 0;
            const fragment = templateClone.ownerDocument.createDocumentFragment();

            while ((match = placeholderRegex.exec(originalValue)) !== null) {
                // Add the text before the placeholder
                if (match.index > lastIndex) {
                    fragment.appendChild(templateClone.ownerDocument.createTextNode(originalValue.substring(lastIndex, match.index)));
                }

                const placeholderText = match[0];
                if (placeholderText === '[[...]]') {
                    // Delegate to child nodes
                    for (const xmlChild of Array.from(xmlContextNode.childNodes)) {
                        _processNode(engineState, xmlChild, fragment);
                    }
                } else {
                    // Resolve other placeholders
                    try {
                        const parsed = placeholderParser.parse(placeholderText);
                        const resolvedValue = _resolvePlaceholder(engineState, xmlContextNode, parsed);
                        fragment.appendChild(templateClone.ownerDocument.createTextNode(resolvedValue));
                    } catch (e) { /* ignore malformed placeholders */ }
                }
                lastIndex = placeholderRegex.lastIndex;
            }

            // Add any remaining text after the last placeholder
            if (lastIndex < originalValue.length) {
                fragment.appendChild(templateClone.ownerDocument.createTextNode(originalValue.substring(lastIndex)));
            }
            
            // Only replace if there were placeholders
            if (lastIndex > 0) {
                 templateClone.replaceChild(fragment, child);
            }
        }
    }
}


/**
 * Applies a template to a single XML node to generate an output fragment.
 * @param {object} engineState - The central state object.
 * @param {Node} xmlNode - The specific XML node to be transformed.
 * @param {Node} templateNode - The template node that matched the XML node.
 * @param {Node} parentOutputNode - The output node where the generated content will be appended.
 * @param {object|null} overrideAttributes - Attributes to merge onto the new output node.
 */
function _applyTemplate(engineState, xmlNode, templateNode, parentOutputNode, overrideAttributes = null) {
    engineState.processedUuids.add(xmlNode.getAttribute('data-uuid'));
    const tagName = templateNode.tagName.toLowerCase();

    if (tagName === 'null-template') return;

    if (tagName === 'template' || tagName === 'unprocessed-template') {
        const tempContainer = parentOutputNode.ownerDocument.createElement('div');
        for (const child of Array.from(templateNode.childNodes)) {
            tempContainer.appendChild(child.cloneNode(true));
        }
        _fillTemplate(engineState, xmlNode, tempContainer);
        while (tempContainer.firstChild) {
            parentOutputNode.appendChild(tempContainer.firstChild);
        }
        return;
    }

    const newOutputNode = templateNode.cloneNode(true);
    if (xmlNode.attributes) {
        for (const attr of Array.from(xmlNode.attributes)) {
            if (attr.name.startsWith('data-')) newOutputNode.setAttribute(attr.name, attr.value);
        }
    }
    newOutputNode.removeAttribute('data-xml-selector');
    if (overrideAttributes) {
        for (const [key, value] of Object.entries(overrideAttributes)) {
            newOutputNode.setAttribute(key, value);
        }
    }
    _fillTemplate(engineState, xmlNode, newOutputNode);
    parentOutputNode.appendChild(newOutputNode);
}


/**
 * [MODIFIED] The main processing function for a single XML node. Now handles PIs and unprocessed fallbacks.
 * @param {object} engineState - The central state object.
 * @param {Node} xmlNode - The current XML node to process.
 * @param {Node} parentOutputNode - The output node to append any generated content to.
 * @param {object|null} overrideAttributes - Attributes from an <apply-template> call.
 */
function _processNode(engineState, xmlNode, parentOutputNode, overrideAttributes = null) {
    if (xmlNode.nodeType === 7) { // Node.PROCESSING_INSTRUCTION_NODE
        _processPiNode(engineState, xmlNode, parentOutputNode);
        return;
    }
    
    if (xmlNode.nodeType === 3) {
        if (!/^\s*$/.test(xmlNode.nodeValue)) {
            const textValue = engineState.context.engine?.escapeFn ? engineState.context.engine.escapeFn(xmlNode.nodeValue) : xmlNode.nodeValue;
            parentOutputNode.appendChild(parentOutputNode.ownerDocument.createTextNode(textValue));
        }
        return;
    }

    if (xmlNode.nodeType !== 1) return;

    const { bestMatch } = _findBestMatch(xmlNode, engineState);

    if (bestMatch) {
        _applyTemplate(engineState, xmlNode, bestMatch.template, parentOutputNode, overrideAttributes);
    } else {
        // Use the unprocessed template for fallback.
        _applyTemplate(engineState, xmlNode, engineState.unprocessedTemplate, parentOutputNode, overrideAttributes);
    }
}

// --- [NEW] Processing Instruction (PI) Pipeline ---

/**
 * [MODIFIED] Parses the data string of a PI into a key-value object of pseudo-attributes.
 * Uses a dedicated Peggy parser for better readability and maintenance.
 * @param {string} dataString - The PI's data content.
 * @returns {object} An object of parsed pseudo-attributes.
 */
function _parsePiData(dataString) {
    try {
        // Use the dedicated Peggy parser for better readability and maintenance.
        return piAttributeParser.parse(dataString.trim());
    } catch (e) {
        // Fallback for malformed PI data to prevent crashes.
        return {};
    }
}

/**
 * [NEW] Finds the best matching PI template for a given PI node.
 * @param {Node} piNode - The Processing Instruction node.
 * @param {object} engineState - The central state object.
 * @returns {object} The best matching PI template.
 */
function _findBestPiMatch(piNode, engineState) {
    let bestMatch = null;
    let bestSpecificity = -1;

    // Lazily parse and cache the PI data
    if (!engineState.piDataCache.has(piNode)) {
        engineState.piDataCache.set(piNode, _parsePiData(piNode.data));
    }
    const piData = engineState.piDataCache.get(piNode);

    for (const template of engineState.piTemplates) {
        const target = template.getAttribute('target');
        if (target !== piNode.target) continue;

        let currentSpecificity = 0;
        const matchAttr = template.getAttribute('match');

        if (matchAttr) {
            const parsedSelector = selectorParser.parse(`dummy[${matchAttr}]`);
            const selectorAttr = parsedSelector.parts[0].attributes[0];

            if (selectorAttr && piData.hasOwnProperty(selectorAttr.name)) {
                if (selectorAttr.value !== undefined) {
                    if (piData[selectorAttr.name] === selectorAttr.value) {
                        currentSpecificity = 2; // target + attr value match
                    } else {
                        continue; // Value doesn't match
                    }
                } else {
                    currentSpecificity = 1; // target + attr presence match
                }
            } else {
                continue; // Attribute not found
            }
        }
        
        if (currentSpecificity > bestSpecificity) {
            bestSpecificity = currentSpecificity;
            bestMatch = template;
        }
    }
    return bestMatch;
}

/**
 * [NEW] Applies a PI template to generate an output fragment.
 * @param {object} engineState - The central state object.
 * @param {Node} piNode - The PI node to transform.
 * @param {Node} template - The matched PI template.
 * @param {Node} parentOutputNode - The output node to append content to.
 */
function _applyPiTemplate(engineState, piNode, template, parentOutputNode) {
    const tempContainer = parentOutputNode.ownerDocument.createElement('div');
    for (const child of Array.from(template.childNodes)) {
        tempContainer.appendChild(child.cloneNode(true));
    }

    const childNodes = Array.from(tempContainer.childNodes);
    for (const child of childNodes) {
        if (child.nodeType === 3) { // Text Node
            const placeholders = child.nodeValue.match(/\[\[\s*.*?]]/g);
            if (placeholders) {
                let finalValue = child.nodeValue;
                for (const placeholderText of placeholders) {
                    try {
                        const parsed = placeholderParser.parse(placeholderText);
                        const resolvedValue = _resolvePlaceholder(engineState, null, parsed, piNode);
                        finalValue = finalValue.replace(placeholderText, resolvedValue);
                    } catch (e) { /* continue */ }
                }
                tempContainer.replaceChild(parentOutputNode.ownerDocument.createTextNode(finalValue), child);
            }
        }
    }

    while (tempContainer.firstChild) {
        parentOutputNode.appendChild(tempContainer.firstChild);
    }
}

/**
 * [NEW] The main processing function for a single PI node.
 * @param {object} engineState - The central state object.
 * @param {Node} piNode - The PI node.
 * @param {Node} parentOutputNode - The output node to append content to.
 */
function _processPiNode(engineState, piNode, parentOutputNode) {
    const bestMatch = _findBestPiMatch(piNode, engineState);
    if (bestMatch) {
        _applyPiTemplate(engineState, piNode, bestMatch, parentOutputNode);
    }
    // If no match, the PI is silently ignored.
}

// --- Pipeline and Validation ---
function _addUuids(xmlDoc, nanoid) {
    const allElements = xmlDoc.getElementsByTagName('*');
    for (let i = 0; i < allElements.length; i++) {
        if (!allElements[i].hasAttribute('data-uuid')) {
            allElements[i].setAttribute('data-uuid', nanoid(7));
        }
    }
}
function _validateContent(xmlDoc, engineState) {
    const unprocessedNodes = [];
    const elements = xmlDoc.getElementsByTagName('*');
    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const uuid = el.getAttribute('data-uuid');
        if (!engineState.processedUuids.has(uuid)) {
            unprocessedNodes.push({
                uuid,
                tagName: el.tagName,
                path: _getNodePath(el)
            });
        }
    }
    return {
        totalNodes: elements.length,
        processedNodes: engineState.processedUuids.size,
        unprocessedNodes: unprocessedNodes,
    };
}
// ... (omitting other validation/pipeline functions for brevity as they are unchanged)

// --- Main Public API ---

/**
 * [MODIFIED] Transforms an XML string into a text string based on a template file.
 * Now supports TeX-specific features and a generic output model.
 * @param {string} xmlString - The source XML content as a string.
 * @param {string} templateString - The template content as a string.
 * @param {object} [customProcessors={}] - Optional object for `preProcessors`, `postProcessors`, and `filters`.
 * @param {object} [context={}] - Optional object for external data. A special `context.engine.escapeFn` can be provided.
 * @returns {Promise<{output: string, report: object, performance: object}>} A promise that resolves to the result.
 */
async function transform(xmlString, templateString, customProcessors = {}, context = {}) {
    const startMem = process.memoryUsage();
    const startCpu = process.cpuUsage();
    
    const { nanoid } = await import('nanoid');

    // --- Setup and Template Parsing ---
    const templateDoc = new DOMParser().parseFromString(templateString, 'text/html');
    const templatesRoot = templateDoc.getElementsByTagName('templates')[0];
    if (templatesRoot) {
        _cleanTemplateDOM(templatesRoot);
    }

    // Build caches for element and PI templates
    const templateCache = { '*': [] };
    const piTemplates = [];
    let unprocessedTemplate = null;
    const allTemplates = templatesRoot ? Array.from(templatesRoot.childNodes).filter(n => n.nodeType === 1) : [];
    
    for (const template of allTemplates) {
        const tagName = template.tagName.toLowerCase();
        if (tagName === 'pi-template') {
            if (template.hasAttribute('target')) piTemplates.push(template);
        } else if (tagName === 'unprocessed-template') {
            unprocessedTemplate = template;
        }
        else {
            const selector = template.getAttribute('data-xml-selector');
            if (selector) {
                try {
                    const parsedResult = selectorParser.parse(selector.trim());
                    const lastPart = parsedResult.parts[parsedResult.parts.length - 1];
                    const tag = lastPart.tag.toLowerCase();
                    if (!templateCache[tag]) templateCache[tag] = [];
                    templateCache[tag].push(template);
                } catch (e) { /* ignore invalid selectors */ }
            }
        }
    }
    
    if (!unprocessedTemplate) {
        const defaultUnprocessedStr = `<unprocessed-template>\\unhandledtag{[[@tagName]]}{[[...]]}</unprocessed-template>`;
        unprocessedTemplate = new DOMParser().parseFromString(defaultUnprocessedStr, 'text/xml').documentElement;
    }


    // Default to TeX escaping if no escape function is provided
    if (!context.engine) context.engine = {};
    if (!context.engine.escapeFn) {
        context.engine.escapeFn = _escapeTex;
    }
    
    const engineState = {
        processedUuids: new Set(),
        unprocessedReasons: new Map(),
        templateCache: templateCache,
        piTemplates: piTemplates,
        unprocessedTemplate: unprocessedTemplate,
        piDataCache: new Map(),
        filters: {
            raw: (val) => val,
            ...(customProcessors.filters || {}),
        },
        context: context
    };

    let xmlDoc = new DOMParser().parseFromString(xmlString, 'application/xml');
    _addUuids(xmlDoc, nanoid);

    // --- Core Transformation ---
    const outputDoc = new DOMParser().parseFromString('<root/>', 'application/xml');
    _processNode(engineState, xmlDoc.documentElement, outputDoc.documentElement);

    // --- Serialization and Reporting ---
    const outputContent = Array.from(outputDoc.documentElement.childNodes)
        .map(node => new XMLSerializer().serializeToString(node))
        .join('');

    let finalOutput = outputContent;
    if (customProcessors.postProcessors) {
        let finalOutputDom = new DOMParser().parseFromString(`<div>${outputContent}</div>`, 'text/html');
        for (const processor of customProcessors.postProcessors) {
            if (typeof processor === 'function') processor(finalOutputDom, context);
        }
        finalOutput = Array.from(finalOutputDom.documentElement.childNodes)
            .map(node => new XMLSerializer().serializeToString(node))
            .join('');
    }
    
    const report = _validateContent(xmlDoc, engineState);
    
    // --- Performance Metrics ---
    const endMem = process.memoryUsage();
    const endCpu = process.cpuUsage();
    const perfData = {
        memoryUsage: {
            heapUsed: (endMem.heapUsed - startMem.heapUsed) / (1024 * 1024), // In MB
        },
        cpuUsage: {
            user: (endCpu.user - startCpu.user) / 1000, // In milliseconds
            system: (endCpu.system - startCpu.system) / 1000, // In milliseconds
        }
    };

    return { output: finalOutput, report, performance: perfData };
}


module.exports = {
    transform,
    createSelectorParser,
    createPlaceholderParser,
    compareSpecificity
};

