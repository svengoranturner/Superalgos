'use strict'

/*
    A small XML reader for the Trading API.

    The Trading API is the only route to a final sale price, and it speaks
    XML. Rather than take a dependency for it, this parses the narrow
    subset eBay actually emits: nested elements, text content, CDATA,
    self-closing tags. Attributes are skipped - no response field we need
    lives in one.

    Repeated siblings collapse to arrays, so <Item> lists behave sensibly.
*/

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities (text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code) => {
        if (code[0] === '#') {
            const value = code[1] === 'x' || code[1] === 'X'
                ? parseInt(code.slice(2), 16)
                : parseInt(code.slice(1), 10)
            return Number.isFinite(value) ? String.fromCodePoint(value) : whole
        }
        return ENTITIES[code] !== undefined ? ENTITIES[code] : whole
    })
}

exports.parse = function (xml) {

    /*
        CDATA is neutralised BEFORE the tag scan, not during it. Its
        contents can legitimately contain '<' and '>' - eBay listing
        descriptions are full of HTML - and a raw scan would parse those as
        real tags and corrupt the element stack.
    */
    const source = String(xml)
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (whole, inner) => exports.escape(inner))
    const root = {}
    const stack = [root]
    let cursor = 0

    const tagPattern = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g
    let match

    while ((match = tagPattern.exec(source)) !== null) {
        const [whole, closing, rawName, , selfClosing] = match

        /* Text sitting between the previous tag and this one. */
        const text = source.slice(cursor, match.index)
        cursor = match.index + whole.length

        if (text.trim().length > 0) {
            const node = stack[stack.length - 1]
            const value = decodeEntities(text.trim())
            if (value.length > 0) { node.__text = (node.__text || '') + value }
        }

        /* Strip namespace prefixes: eBay's responses are namespaced and
           the prefix carries no information we use. */
        const name = rawName.includes(':') ? rawName.split(':').pop() : rawName

        if (closing === '/') {
            const finished = stack.pop()
            collapse(stack[stack.length - 1], name, finished)
            continue
        }

        const node = {}
        if (selfClosing === '/') {
            collapse(stack[stack.length - 1], name, node)
        } else {
            stack.push(node)
            node.__name = name
        }
    }

    return root
}

function collapse (parent, name, node) {
    if (parent === undefined) { return }
    delete node.__name

    const keys = Object.keys(node)
    /* A node with only text becomes its text - the common leaf case. */
    const value = (keys.length === 1 && keys[0] === '__text') ? node.__text
        : (keys.length === 0 ? '' : node)

    if (parent[name] === undefined) {
        parent[name] = value
    } else if (Array.isArray(parent[name])) {
        parent[name].push(value)
    } else {
        parent[name] = [parent[name], value]
    }
}

/* Safe nested lookup: get(obj, 'GetItemResponse.Item.SellingStatus.BidCount') */
exports.get = function (object, path) {
    let node = object
    for (const key of path.split('.')) {
        if (node === null || node === undefined || typeof node !== 'object') { return undefined }
        node = node[key]
    }
    return node
}

exports.escape = function (value) {
    return String(value).replace(/[<>&'"]/g, c => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
    })[c])
}
