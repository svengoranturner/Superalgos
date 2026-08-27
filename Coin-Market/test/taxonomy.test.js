'use strict'

const test = require('node:test')
const assert = require('node:assert')

const TAXONOMY = require('../src/ebay/taxonomy.js')

const SUBTREE = {
    categorySubtreeNode: {
        category: { categoryId: '11116', categoryName: 'Coins, Banknotes & Bullion' },
        childCategoryTreeNodes: [
            {
                category: { categoryId: '3394', categoryName: 'Coins' },
                childCategoryTreeNodes: [
                    { category: { categoryId: '3408', categoryName: 'British Gold Coins' }, leafCategoryTreeNode: true },
                    { category: { categoryId: '3406', categoryName: 'British Crowns' }, leafCategoryTreeNode: true }
                ]
            },
            {
                category: { categoryId: '177652', categoryName: 'Bullion' },
                childCategoryTreeNodes: [
                    { category: { categoryId: '999', categoryName: 'Gold Sovereign Bullion' }, leafCategoryTreeNode: true }
                ]
            }
        ]
    }
}

test('the root category name is excluded from match paths', () => {
    /*
        Regression: eBay's coin root is literally named "Coins, Banknotes &
        Bullion". Matching a /bullion/ pattern against the full root-to-leaf
        path therefore matched every leaf beneath it - so a sovereign search
        would have swept in banknotes and crowns while looking perfectly
        sensible.
    */
    const flat = TAXONOMY.flattenSubtree(SUBTREE)
    const crowns = flat.find(n => n.categoryId === '3406')
    assert.match(crowns.path, /Bullion/, 'the full path does contain the root name')
    assert.doesNotMatch(crowns.pathBelowRoot, /Bullion/, 'the match path must not')
})

test('the category subtree flattens with full paths and leaf flags', () => {
    const flat = TAXONOMY.flattenSubtree(SUBTREE)
    assert.strictEqual(flat.length, 6)

    const leaf = flat.find(n => n.categoryId === '3408')
    assert.strictEqual(leaf.leaf, true)
    assert.strictEqual(leaf.path, 'Coins, Banknotes & Bullion > Coins > British Gold Coins')

    const branch = flat.find(n => n.categoryId === '3394')
    assert.strictEqual(branch.leaf, false)
})

test('sovereign leaves are found across BOTH the coin and bullion branches', () => {
    /*
        Sovereigns are split between the coin tree and a separate bullion
        tree. Matching only one branch would miss roughly half the market
        while returning results that look perfectly reasonable.
    */
    const leaves = TAXONOMY.matchingLeaves(TAXONOMY.flattenSubtree(SUBTREE), TAXONOMY.SOVEREIGN_PATTERNS)
    const ids = leaves.map(l => l.categoryId).sort()

    assert.ok(ids.includes('3408'), 'the coin-branch gold leaf')
    assert.ok(ids.includes('999'), 'the bullion-branch sovereign leaf')
    assert.ok(!ids.includes('3406'), 'crowns are not sovereigns')
})

test('only leaves are returned, never branches', () => {
    /* Partitioning by leaf is what keeps each query under eBay's
       10,000-item result cap. */
    const leaves = TAXONOMY.matchingLeaves(TAXONOMY.flattenSubtree(SUBTREE), [/./])
    assert.ok(leaves.every(l => l.leaf === true))
    assert.ok(leaves.every(l => l.categoryId !== null))
})

test('a malformed subtree does not throw', () => {
    const flat = TAXONOMY.flattenSubtree({})
    assert.strictEqual(flat.length, 1)
    assert.strictEqual(flat[0].categoryId, null)
    assert.doesNotThrow(() => TAXONOMY.flattenSubtree({ categorySubtreeNode: null }))
})
