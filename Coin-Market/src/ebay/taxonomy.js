'use strict'

/*
    Taxonomy API.

    Category ids are marketplace-specific. The sovereign category numbers
    that circulate online are from the US tree, and assuming they hold for
    EBAY_GB would silently search the wrong branch - returning results
    that look plausible while missing most of the market.

    So the ids are enumerated from eBay rather than hardcoded, and written
    into config/coins.sovereign.json where they can be reviewed.

    Application token is sufficient; no user consent needed.
*/

exports.newTaxonomyClient = function (auth, options) {

    const config = Object.assign({ budget: null }, options || {})

    async function call (path, params) {
        const token = await auth.applicationToken()
        const url = new URL(auth.endpoints.taxonomy + path)
        for (const [key, value] of Object.entries(params || {})) {
            if (value !== undefined && value !== null) { url.searchParams.set(key, String(value)) }
        }

        const response = await fetch(url, {
            headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json',
                /* Subtrees are large; gzip is worth asking for. */
                'Accept-Encoding': 'gzip'
            }
        })
        if (config.budget !== null) { config.budget.record('taxonomy') }

        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
            const detail = (payload.errors && payload.errors[0]) || {}
            throw new Error('Taxonomy ' + path + ' failed (' + response.status + '): ' +
                (detail.message || 'unknown'))
        }
        return payload
    }

    return {
        async defaultCategoryTreeId (marketplaceId) {
            const payload = await call('/get_default_category_tree_id',
                { marketplace_id: marketplaceId })
            return payload.categoryTreeId
        },

        async categorySubtree (treeId, categoryId) {
            return call('/category_tree/' + encodeURIComponent(treeId) + '/get_category_subtree',
                { category_id: categoryId })
        },

        async itemAspectsForCategory (treeId, categoryId) {
            return call('/category_tree/' + encodeURIComponent(treeId) + '/get_item_aspects_for_category',
                { category_id: categoryId })
        }
    }
}

/*
    Flattens a subtree response into a list. eBay nests categories
    arbitrarily deep, and what we want is every node with its leaf flag so
    searches can target leaves and humans can read the branch names.
*/
exports.flattenSubtree = function (payload) {
    const root = payload.categorySubtreeNode || payload
    const out = []

    function walk (node, depth, path) {
        if (node === null || typeof node !== 'object') { return }
        const category = node.category || {}
        const name = category.categoryName || ''
        const here = path.concat(name).filter(Boolean)

        out.push({
            categoryId: category.categoryId || null,
            categoryName: name,
            depth,
            leaf: node.leafCategoryTreeNode === true,
            path: here.join(' > '),
            /*
                Path with the root segment dropped. Matching must never see
                the root name: eBay's coin root is "Coins, Banknotes &
                Bullion", so a /bullion/ pattern tested against the full
                path matches EVERY leaf beneath it - dragging banknotes and
                crowns into a sovereign search while looking correct.
            */
            pathBelowRoot: here.slice(1).join(' > ')
        })

        for (const child of node.childCategoryTreeNodes || []) { walk(child, depth + 1, here) }
    }

    walk(root, 0, [])
    return out
}

/*
    Picks the categories worth searching for a keyword set.

    Deliberately returns LEAVES ONLY. Browse accepts a parent id and
    searches beneath it, but leaves make the partitioning explicit - and
    partitioning is what keeps each query under the 10,000-item result cap.
*/
exports.matchingLeaves = function (flattened, patterns) {
    return flattened.filter(node =>
        node.leaf && node.categoryId !== null &&
        patterns.some(pattern => pattern.test(node.pathBelowRoot || node.categoryName)))
}

/* Category branches a sovereign can live in. Sovereigns are split across
   the coin tree and a separate bullion tree - searching one misses half
   the market, which is why this is a list rather than a single id. */
exports.SOVEREIGN_PATTERNS = [
    /sovereign/i,
    /gold.*coin/i,
    /coin.*gold/i,
    /bullion/i
]

/* Top of the Coins branch. Confirmed present on ebay.co.uk as
   "Coins, Banknotes & Bullion"; the same id is "Coins & Paper Money" on
   ebay.com, so it is stable across marketplaces even though the leaves
   below it are not. */
exports.COINS_ROOT = '11116'
