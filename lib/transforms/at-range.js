
import Block from '../models/block'
import Inline from '../models/inline'
import Normalize from '../utils/normalize'
import Selection from '../models/selection'
import Text from '../models/text'
import isInRange from '../utils/is-in-range'
import uid from '../utils/uid'
import { Set } from 'immutable'

/**
 * Add a new `mark` to the characters at `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Mark || String || Object} mark
 * @return {Transform}
 */

export function addMarkAtRange(transform, range, mark) {
  let { state } = transform
  let { document } = state

  // Normalize the mark.
  mark = Normalize.mark(mark)

  // When the range is collapsed, do nothing.
  if (range.isCollapsed) return transform

  // Otherwise, find each of the text nodes within the range.
  const { startKey, startOffset, endKey, endOffset } = range
  let texts = document.getTextsAtRange(range)

  // Apply the mark to each of the text nodes's matching characters.
  texts = texts.map((text) => {
    let characters = text.characters.map((char, i) => {
      if (!isInRange(i, text, range)) return char
      let { marks } = char
      marks = marks.add(mark)
      return char.merge({ marks })
    })

    return text.merge({ characters })
  })

  // Update each of the text nodes.
  texts.forEach((text) => {
    document = document.updateDescendant(text)
  })

  // Update the state.
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Delete everything in a `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @return {Transform}
 */

export function deleteAtRange(transform, range) {
  let { state } = transform
  let { document } = state

  // If the range is collapsed, there's nothing to delete.
  if (range.isCollapsed) return transform

  // Make sure the children exist.
  const { startKey, startOffset, endKey, endOffset } = range
  document.assertDescendant(startKey)
  document.assertDescendant(endKey)

  // If the start and end nodes are the same, just remove characters.
  if (startKey == endKey) {
    let text = document.getDescendant(startKey)
    text = text.removeText(startOffset, endOffset - startOffset)
    document = document.updateDescendant(text)
    document = document.normalize()
    state = state.merge({ document })
    transform.state = state
    return transform
  }

  // Split the blocks and determine the edge boundaries.
  const start = range.collapseToStart()
  const end = range.collapseToEnd()
  let startBlock = document.getClosestBlock(startKey)
  let endBlock = document.getClosestBlock(endKey)
  const startDepth = document.getDepth(startBlock)
  const endDepth = document.getDepth(endBlock)

  let ancestor = document.getCommonAncestor(startKey, endKey)
  let isAncestor = ancestor == document
  const ancestorDepth = isAncestor ? 0 : document.getDepth(ancestor)

  transform = splitBlockAtRange(transform, start, startDepth - ancestorDepth)
  transform = splitBlockAtRange(transform, end, endDepth - ancestorDepth)
  state = transform.state
  document = state.document
  ancestor = document.getCommonAncestor(startKey, endKey)

  const startText = ancestor.getDescendant(startKey)
  const startEdgeText = ancestor.getNextText(startKey)

  const endText = ancestor.getNextText(endKey)
  const endEdgeText = ancestor.getDescendant(endKey)

  startBlock = document.getClosestBlock(startText)
  endBlock = document.getClosestBlock(endText)

  // Remove the new blocks inside the edges.
  const startEdgeBlock = ancestor.getFurthestBlock(startEdgeText)
  const endEdgeBlock = ancestor.getFurthestBlock(endEdgeText)

  const nodes = ancestor.nodes
    .takeUntil(n => n == startEdgeBlock)
    .concat(ancestor.nodes.skipUntil(n => n == endEdgeBlock).rest())

  ancestor = ancestor.merge({ nodes })

  // Take the end edge's inline nodes and move them to the start edge.
  const startNodes = startBlock.nodes.concat(endBlock.nodes)
  startBlock = startBlock.merge({ nodes: startNodes })
  ancestor = ancestor.updateDescendant(startBlock)

  // While the end child is an only child, remove the block it's in.
  let endParent = ancestor.getClosestBlock(endBlock)

  while (endParent && endParent.nodes.size == 1) {
    endBlock = endParent
    endParent = ancestor.getClosestBlock(endParent)
  }

  ancestor = ancestor.removeDescendant(endBlock)

  // Update the document.
  document = isAncestor
    ? ancestor
    : document.updateDescendant(ancestor)

  // Normalize the adjacent text nodes.
  document = document.normalize()

  // Update the state.
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Delete backward `n` characters at a `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Number} n (optional)
 * @return {Transform}
 */

export function deleteBackwardAtRange(transform, range, n = 1) {
  let { state } = transform
  let { document } = state
  const { startKey, startOffset } = range

  // When the range is still expanded, just do a regular delete.
  if (range.isExpanded) return deleteAtRange(transform, range)

  // When collapsed at the start of the node, there's nothing to do.
  if (range.isAtStartOf(document)) return transform

  // When collapsed in a void node, remove that node.
  const block = document.getClosestBlock(startKey)
  if (block && block.isVoid) {
    document = document.removeDescendant(block)
    state = state.merge({ document })
    transform.state = state
    return transform
  }

  const inline = document.getClosestInline(startKey)
  if (inline && inline.isVoid) {
    document = document.removeDescendant(inline)
    state = state.merge({ document })
    transform.state = state
    return transform
  }

  // When at start of a text node, merge forwards into the next text node.
  const startNode = document.getDescendant(startKey)

  if (range.isAtStartOf(startNode)) {
    const previous = document.getPreviousText(startNode)

    // If the previous descendant is void, remove it.
    const prevBlock = document.getClosestBlock(previous)
    if (prevBlock && prevBlock.isVoid) {
      document = document.removeDescendant(prevBlock)
      state = state.merge({ document })
      transform.state = state
      return transform
    }

    const prevInline = document.getClosestInline(previous)
    if (prevInline && prevInline.isVoid) {
      document = document.removeDescendant(prevInline)
      state = state.merge({ document })
      transform.state = state
      return transform
    }

    range = range.extendToEndOf(previous)
    range = range.normalize(document)
    return deleteAtRange(transform, range)
  }

  // Otherwise, remove `n` characters behind of the cursor.
  range = range.extendBackward(n)
  range = range.normalize(document)
  return deleteAtRange(transform, range)
}

/**
 * Delete forward `n` characters at a `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Number} n (optional)
 * @return {Transform}
 */

export function deleteForwardAtRange(transform, range, n = 1) {
  let { state } = transform
  let { document } = state
  const { startKey } = range

  // When the range is still expanded, just do a regular delete.
  if (range.isExpanded) return deleteAtRange(transform, range)

  // When collapsed at the end of the node, there's nothing to do.
  if (range.isAtEndOf(document)) return transform

  // When collapsed in a void node, remove that node.
  const block = document.getClosestBlock(startKey)
  if (block && block.isVoid) {
    document = document.removeDescendant(block)
    state = state.merge({ document })
    transform.state = state
    return transform
  }

  const inline = document.getClosestInline(startKey)
  if (inline && inline.isVoid) {
    document = document.removeDescendant(inline)
    state = state.merge({ document })
    transform.state = state
    return transform
  }

  // When at end of a text node, merge forwards into the next text node.
  const startNode = document.getDescendant(startKey)
  if (range.isAtEndOf(startNode)) {
    const next = document.getNextText(startNode)
    range = range.extendToStartOf(next)
    range = range.normalize(document)
    return deleteAtRange(transform, range)
  }

  // Otherwise, remove `n` characters ahead of the cursor.
  range = range.extendForward(n)
  range = range.normalize(document)
  return deleteAtRange(transform, range)
}

/**
 * Insert a `block` node at `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Block or String or Object} block
 * @return {Transform}
 */

export function insertBlockAtRange(transform, range, block) {
  let { state } = transform
  let { document } = state

  // Normalize the block argument.
  block = Normalize.block(block)

  // If expanded, delete the range first.
  if (range.isExpanded) {
    transform = deleteAtRange(transform, range)
    state = transform.state
    document = state.document
    range = range.collapseToStart()
  }

  const { startKey, startOffset } = range
  let startBlock = document.getClosestBlock(startKey)
  let parent = document.getParent(startBlock)
  let nodes = Block.createList([block])
  const isParent = parent == document

  // If the start block is void, insert after it.
  if (startBlock.isVoid) {
    parent = parent.insertChildrenAfter(startBlock, nodes)
  }

  // If the block is empty, replace it.
  else if (startBlock.isEmpty) {
    parent = parent.insertChildrenAfter(startBlock, nodes)
    parent = parent.removeDescendant(startBlock)
  }

  // If the range is at the start of the block, insert before.
  else if (range.isAtStartOf(startBlock)) {
    parent = parent.insertChildrenBefore(startBlock, nodes)
  }

  // If the range is at the end of the block, insert after.
  else if (range.isAtEndOf(startBlock)) {
    parent = parent.insertChildrenAfter(startBlock, nodes)
  }

  // Otherwise, split the block and insert between.
  else {
    transform = splitBlockAtRange(transform, range)
    state = transform.state
    document = state.document
    parent = document.getParent(startBlock)
    startBlock = document.getClosestBlock(startKey)
    nodes = parent.nodes.takeUntil(n => n == startBlock)
      .push(startBlock)
      .push(block)
      .concat(parent.nodes.skipUntil(n => n == startBlock).rest())
    parent = parent.merge({ nodes })
  }

  // Update the document.
  document = isParent
    ? parent
    : document.updateDescendant(parent)

  // Normalize the document.
  document = document.normalize()

  // Return the updated state.
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Insert a `fragment` at a `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Document} fragment
 * @return {Transform}
 */

export function insertFragmentAtRange(transform, range, fragment) {
  let { state } = transform
  let { document } = state

  // Ensure that the selection is normalized.
  range = range.normalize(document)

  // If the range is expanded, delete first.
  if (range.isExpanded) {
    transform = deleteAtRange(transform, range)
    state = transform.state
    document = state.document
    range = range.collapseToStart()
  }

  // If the fragment is empty, do nothing.
  if (!fragment.length) return transform

  // Make sure each node in the fragment has a unique key.
  fragment = fragment.mapDescendants(child => child.set('key', uid()))

  // Split the inlines if need be.
  if (!document.isInlineSplitAtRange(range)) {
    transform = splitInlineAtRange(transform, range)
    state = transform.state
    document = state.document
  }

  // Determine the start and next children to insert into.
  const { startKey, endKey } = range
  let block = document.getClosestBlock(startKey)
  let start = document.getDescendant(startKey)
  let startChild
  let nextChild

  if (range.isAtStartOf(document)) {
    nextChild = document.getClosestBlock(document.getTexts().first())
  }

  if (range.isAtStartOf(block)) {
    nextChild = block.getHighestChild(block.getTexts().first())
  }

  else if (range.isAtStartOf(start)) {
    startChild = block.getHighestChild(block.getPreviousText(start))
    nextChild = block.getNextSibling(startChild)
  }

  else {
    startChild = block.getHighestChild(start)
    nextChild = block.getNextSibling(startChild)
  }

  // Get the first and last block of the fragment.
  const blocks = fragment.getBlocks()
  const firstBlock = blocks.first()
  let lastBlock = blocks.last()

  // If the block is empty, merge in the first block's type and data.
  if (block.length == 0) {
    block = block.merge({
      type: firstBlock.type,
      data: firstBlock.data
    })
  }

  // Insert the first blocks nodes into the starting block.
  if (startChild) {
    block = block.insertChildrenAfter(startChild, firstBlock.nodes)
  } else {
    block = block.insertChildrenBefore(nextChild, firstBlock.nodes)
  }

  document = document.updateDescendant(block)

  // If there are no other siblings, that's it.
  if (firstBlock == lastBlock) {
    document = document.normalize()
    state = state.merge({ document })
    transform.state = state
    return transform
  }

  // Otherwise, remove the fragment's first block's highest solo parent...
  let highestParent = fragment.getHighestOnlyChildParent(firstBlock)
  fragment = fragment.removeDescendant(highestParent || firstBlock)

  // Then, add the inlines after the cursor from the current block to the
  // start of the last block in the fragment.
  if (nextChild) {
    lastBlock = lastBlock.concatChildren(block.getChildrenAfterIncluding(nextChild))
    fragment = fragment.updateDescendant(lastBlock)

    block = block.removeChildrenAfterIncluding(nextChild)
    document = document.updateDescendant(block)
  }

  // Finally, add the fragment's children after the block.
  document = document.insertChildrenAfter(block, fragment.nodes)
  document = document.normalize()
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Insert an `inline` node at `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Inline or String or Object} inline
 * @return {Transform}
 */

export function insertInlineAtRange(transform, range, inline) {
  let { state } = transform
  let { document } = state

  // Normalize the inline argument.
  inline = Normalize.inline(inline)

  // If expanded, delete the range first.
  if (range.isExpanded) {
    transform = deleteAtRange(transform, range)
    state = transform.state
    document = state.document
    range = range.collapseToStart()
  }

  const { startKey, endKey, startOffset, endOffset } = range

  // If the range is inside a void, abort.
  const startBlock = document.getClosestBlock(startKey)
  if (startBlock && startBlock.isVoid) return transform

  const startInline = document.getClosestInline(startKey)
  if (startInline && startInline.isVoid) return transform

  // Split the text nodes at the cursor.
  transform = splitTextAtRange(transform, range)
  state = transform.state
  document = state.document

  // Insert the inline between the split text nodes.
  const startText = document.getDescendant(startKey)
  let parent = document.getParent(startKey)
  const nodes = parent.nodes.takeUntil(n => n == startText)
    .push(startText)
    .push(inline)
    .concat(parent.nodes.skipUntil(n => n == startText).rest())

  parent = parent.merge({ nodes })
  document = document.updateDescendant(parent)
  document = document.normalize()
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Insert text `string` at a `range`, with optional `marks`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {String} string
 * @param {Set} marks (optional)
 * @return {Transform}
 */

export function insertTextAtRange(transform, range, string, marks) {
  let { state } = transform
  let { document } = state
  const { startKey, startOffset } = range
  const isVoid = document.hasVoidParent(startKey)

  // If inside a void node, do nothing.
  if (isVoid) return transform

  // Is the range is expanded, delete it first.
  if (range.isExpanded) {
    transform = deleteAtRange(transform, range)
    state = transform.state
    document = state.document
    range = range.collapseToStart()
  }

  // Insert text at the range's offset.
  let text = document.getDescendant(startKey)
  text = text.insertText(startOffset, string, marks)
  document = document.updateDescendant(text)

  // Return the updated selection.
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Remove an existing `mark` to the characters at `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Mark or String} mark (optional)
 * @return {Transform}
 */

export function removeMarkAtRange(transform, range, mark) {
  let { state } = transform
  mark = Normalize.mark(mark)
  let { document } = state

  // When the range is collapsed, do nothing.
  if (range.isCollapsed) return transform

  // Otherwise, find each of the text nodes within the range.
  let texts = document.getTextsAtRange(range)

  // Apply the mark to each of the text nodes's matching characters.
  texts = texts.map((text) => {
    let characters = text.characters.map((char, i) => {
      if (!isInRange(i, text, range)) return char
      let { marks } = char
      marks = mark
        ? marks.remove(mark)
        : marks.clear()
      return char.merge({ marks })
    })

    return text.merge({ characters })
  })

  // Update each of the text nodes.
  texts.forEach((text) => {
    document = document.updateDescendant(text)
  })

  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Set the `properties` of block nodes in a `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Object or String} properties
 * @return {Transform}
 */

export function setBlockAtRange(transform, range, properties = {}) {
  let { state } = transform
  properties = Normalize.nodeProperties(properties)
  let { document } = state
  const blocks = document.getBlocksAtRange(range)

  blocks.forEach((block) => {
    block = block.merge(properties)
    document = document.updateDescendant(block)
  })

  document = document.normalize()
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Set the `properties` of inline nodes in a `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Object or String} properties
 * @return {Transform}
 */

export function setInlineAtRange(transform, range, properties = {}) {
  let { state } = transform
  properties = Normalize.nodeProperties(properties)
  let { document } = state
  const inlines = document.getInlinesAtRange(range)

  inlines.forEach((inline) => {
    inline = inline.merge(properties)
    document = document.updateDescendant(inline)
  })

  document = document.normalize()
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Split the block nodes at a `range`, to optional `depth`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Number} depth (optional)
 * @return {Transform}
 */

export function splitBlockAtRange(transform, range, depth = 1) {
  let { state } = transform
  let { document } = state

  // If the range is expanded, remove it first.
  if (range.isExpanded) {
    transform = deleteAtRange(transform, range)
    state = transform.state
    document = state.document
    range = range.collapseToStart()
  }

  // Split the inline nodes at the range.
  transform = splitInlineAtRange(transform, range)
  state = transform.state
  document = state.document

  // Find the highest inline elements that were split.
  const { startKey } = range
  const firstText = document.getDescendant(startKey)
  const secondText = document.getNextText(startKey)
  let firstChild = document.getFurthestInline(firstText) || firstText
  let secondChild = document.getFurthestInline(secondText) || secondText
  let parent = document.getClosestBlock(firstChild)
  let firstChildren
  let secondChildren
  let d = 0

  // While the parent is a block, split the block nodes.
  while (parent && d < depth) {
    firstChildren = parent.nodes.takeUntil(n => n == firstChild).push(firstChild)
    secondChildren = parent.nodes.skipUntil(n => n == secondChild)
    firstChild = parent.merge({ nodes: firstChildren })
    secondChild = Block.create({
      nodes: secondChildren,
      type: parent.type,
      data: parent.data
    })

    // Add the new children.
    const grandparent = document.getParent(parent)
    const nodes = grandparent.nodes
      .takeUntil(n => n.key == firstChild.key)
      .push(firstChild)
      .push(secondChild)
      .concat(grandparent.nodes.skipUntil(n => n.key == firstChild.key).rest())

    // Update the grandparent.
    document = grandparent == document
      ? document.merge({ nodes })
      : document.updateDescendant(grandparent.merge({ nodes }))

    d++
    parent = document.getClosestBlock(firstChild)
  }

  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Split the inline nodes at a `range`, to optional `depth`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Number} depth (optiona)
 * @return {Transform}
 */

export function splitInlineAtRange(transform, range, depth = Infinity) {
  let { state } = transform
  let { document } = state

  // If the range is expanded, remove it first.
  if (range.isExpanded) {
    transform = deleteAtRange(transform, range)
    state = transform.state
    document = state.document
    range = range.collapseToStart()
  }

  // First split the text nodes.
  transform = splitTextAtRange(transform, range)
  state = transform.state
  document = state.document

  // Find the children that were split.
  const { startKey } = range
  let firstChild = document.getDescendant(startKey)
  let secondChild = document.getNextText(firstChild)
  let parent = document.getClosestInline(firstChild)
  let d = 0

  // While the parent is an inline parent, split the inline nodes.
  while (parent && d < depth) {
    firstChild = parent.merge({ nodes: Inline.createList([firstChild]) })
    secondChild = Inline.create({
      nodes: [secondChild],
      type: parent.type,
      data: parent.data
    })

    // Split the children.
    const grandparent = document.getParent(parent)
    const nodes = grandparent.nodes
      .takeUntil(n => n.key == firstChild.key)
      .push(firstChild)
      .push(secondChild)
      .concat(grandparent.nodes.skipUntil(n => n.key == firstChild.key).rest())

    // Update the grandparent.
    document = grandparent == document
      ? document.merge({ nodes })
      : document.updateDescendant(grandparent.merge({ nodes }))

    d++
    parent = document.getClosestInline(firstChild)
  }

  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Split the text nodes at a `range`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @return {Transform}
 */

export function splitTextAtRange(transform, range) {
  let { state } = transform
  let { document } = state

  // If the range is expanded, remove it first.
  if (range.isExpanded) {
    transform = deleteAtRange(transform, range)
    state = transform.state
    document = state.document
    range = range.collapseToStart()
  }

  // Split the text node's characters.
  const { startKey, startOffset } = range
  const text = document.getDescendant(startKey)
  const { characters } = text
  const firstChars = characters.take(startOffset)
  const secondChars = characters.skip(startOffset)
  let firstChild = text.merge({ characters: firstChars })
  let secondChild = Text.create({ characters: secondChars })

  // Split the text nodes.
  let parent = document.getParent(text)
  const nodes = parent.nodes
    .takeUntil(c => c.key == firstChild.key)
    .push(firstChild)
    .push(secondChild)
    .concat(parent.nodes.skipUntil(n => n.key == firstChild.key).rest())

  // Update the nodes.
  parent = parent.merge({ nodes })
  document = document.updateDescendant(parent)
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Add or remove a `mark` from the characters at `range`, depending on whether
 * it's already there.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {Mark or String} mark (optional)
 * @return {Transform}
 */

export function toggleMarkAtRange(transform, range, mark) {
  let { state } = transform
  mark = Normalize.mark(mark)
  let { document } = state

  // When the range is collapsed, do nothing.
  if (range.isCollapsed) return transform

  // Check if the mark exists in the range already.
  const marks = document.getMarksAtRange(range)
  const exists = marks.some(m => m.equals(mark))

  return exists
    ? removeMarkAtRange(transform, range, mark)
    : addMarkAtRange(transform, range, mark)
}

/**
 * Unwrap all of the block nodes in a `range` from a block with `properties`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {String or Object} properties
 * @return {Transform}
 */

export function unwrapBlockAtRange(transform, range, properties) {
  let { state } = transform
  properties = Normalize.nodeProperties(properties)
  let { document } = state

  // Get the deepest blocks in the range.
  const blocks = document.getBlocksAtRange(range)

  // Get the matching wrapper blocks.
  const wrappers = blocks.reduce((memo, text) => {
    const match = document.getClosest(text, (parent) => {
      if (parent.kind != 'block') return false
      if (properties.type && parent.type != properties.type) return false
      if (properties.data && !parent.data.isSuperset(properties.data)) return false
      return true
    })

    if (match) memo = memo.add(match)
    return memo
  }, new Set())

  // For each of the wrapper blocks...
  wrappers.forEach((wrapper) => {
    const first = wrapper.nodes.first()
    const last = wrapper.nodes.last()
    const parent = document.getParent(wrapper)

    // Get the wrapped direct children.
    const children = wrapper.nodes.filter((child) => {
      return blocks.some(block => child == block || child.hasDescendant(block))
    })

    // Determine what the new nodes should be...
    const firstMatch = children.first()
    const lastMatch = children.last()
    let nodes

    // If the first and last both match, remove the wrapper completely.
    if (first == firstMatch && last == lastMatch) {
      nodes = parent.nodes.takeUntil(n => n == wrapper)
        .concat(wrapper.nodes)
        .concat(parent.nodes.skipUntil(n => n == wrapper).rest())
    }

    // If only the last child matches, move the last nodes.
    else if (last == lastMatch) {
      const remain = wrapper.nodes.takeUntil(n => n == firstMatch)
      const updated = wrapper.merge({ nodes: remain })
      nodes = parent.nodes.takeUntil(n => n == wrapper)
        .push(updated)
        .concat(children)
        .concat(parent.nodes.skipUntil(n => n == wrapper).rest())
    }

    // If only the first child matches, move the first ones.
    else if (first == firstMatch) {
      const remain = wrapper.nodes.skipUntil(n => n == lastMatch).rest()
      const updated = wrapper.merge({ nodes: remain })
      nodes = parent.nodes.takeUntil(n => n == wrapper)
        .concat(children)
        .push(updated)
        .concat(parent.nodes.skipUntil(n => n == wrapper).rest())
    }

    // Otherwise, move the middle ones.
    else {
      const firsts = wrapper.nodes.takeUntil(n => n == firstMatch)
      const lasts = wrapper.nodes.skipUntil(n => n == lastMatch).rest()
      const updatedFirst = wrapper.merge({ nodes: firsts })
      const updatedLast = wrapper.merge({ nodes: lasts })
      nodes = parent.nodes.takeUntil(n => n == wrapper)
        .push(updatedFirst)
        .concat(children)
        .push(updatedLast)
        .concat(parent.nodes.skipUntil(n => n == wrapper).rest())
    }

    document = parent == document
      ? document.merge({ nodes })
      : document.updateDescendant(parent.merge({ nodes }))
  })

  document = document.normalize()
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Unwrap the inline nodes in a `range` from an inline with `properties`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {String or Object} properties
 * @return {Transform}
 */

export function unwrapInlineAtRange(transform, range, properties) {
  let { state } = transform
  properties = Normalize.nodeProperties(properties)
  let { document } = state
  let blocks = document.getInlinesAtRange(range)

  // Find the closest matching inline wrappers of each text node.
  const texts = document.getTexts()
  const wrappers = texts.reduce((memo, text) => {
    const match = document.getClosest(text, (parent) => {
      if (parent.kind != 'inline') return false
      if (properties.type && parent.type != properties.type) return false
      if (properties.data && !parent.data.isSuperset(properties.data)) return false
      return true
    })

    if (match) memo = memo.add(match)
    return memo
  }, new Set())

  // Replace each of the wrappers with their child nodes.
  wrappers.forEach((wrapper) => {
    const parent = document.getParent(wrapper)

    // Replace the wrapper in the parent's nodes with the block.
    const nodes = parent.nodes.takeUntil(n => n == wrapper)
      .concat(wrapper.nodes)
      .concat(parent.nodes.skipUntil(n => n == wrapper).rest())

    // Update the parent.
    document = parent == document
      ? document.merge({ nodes })
      : document.updateDescendant(parent.merge({ nodes }))
  })

  document = document.normalize()
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Wrap all of the blocks in a `range` in a new block with `properties`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {String or Object} properties
 * @return {Transform}
 */

export function wrapBlockAtRange(transform, range, properties) {
  let { state } = transform
  properties = Normalize.nodeProperties(properties)
  let { document } = state

  // Get the block nodes, sorted by depth.
  const blocks = document.getBlocksAtRange(range)
  const sorted = blocks.sort((a, b) => {
    const da = document.getDepth(a)
    const db = document.getDepth(b)
    if (da == db) return 0
    else if (da > db) return -1
    else return 1
  })

  // Get the lowest common siblings, relative to the highest block.
  const highest = sorted.first()
  const depth = document.getDepth(highest)
  const siblings = blocks.reduce((memo, block) => {
    const sibling = document.getDepth(block) == depth
      ? block
      : document.getClosest(block, (p) => document.getDepth(p) == depth)
    memo = memo.push(sibling)
    return memo
  }, Block.createList())

  // Wrap the siblings in a new block.
  const wrapper = Block.create({
    nodes: siblings,
    type: properties.type,
    data: properties.data
  })

  // Replace the siblings with the wrapper.
  const first = siblings.first()
  const last = siblings.last()
  const parent = document.getParent(highest)
  const nodes = parent.nodes
    .takeUntil(n => n == first)
    .push(wrapper)
    .concat(parent.nodes.skipUntil(n => n == last).rest())

  // Update the parent.
  document = parent == document
    ? document.merge({ nodes })
    : document.updateDescendant(parent.merge({ nodes }))

  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Wrap the text and inlines in a `range` in a new inline with `properties`.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {String or Object} properties
 * @return {Transform}
 */

export function wrapInlineAtRange(transform, range, properties) {
  let { state } = transform
  properties = Normalize.nodeProperties(properties)
  let { document } = state

  // If collapsed, there's nothing to wrap.
  if (range.isCollapsed) return transform

  // Split at the start of the range.
  const start = range.collapseToStart()
  transform = splitInlineAtRange(transform, start)
  state = transform.state
  document = state.document

  // Determine the new end of the range, and split there.
  const { startKey, startOffset, endKey, endOffset } = range
  const firstNode = document.getDescendant(startKey)
  const nextNode = document.getNextText(startKey)
  const end = startKey != endKey
    ? range.collapseToEnd()
    : Selection.create({
        anchorKey: nextNode.key,
        anchorOffset: endOffset - startOffset,
        focusKey: nextNode.key,
        focusOffset: endOffset - startOffset
      })

  transform = splitInlineAtRange(transform, end)
  state = transform.state
  document = state.document

  // Calculate the new range to wrap around.
  const endNode = document.getDescendant(end.anchorKey)
  range = Selection.create({
    anchorKey: nextNode.key,
    anchorOffset: 0,
    focusKey: endNode.key,
    focusOffset: endNode.length
  })

  // Get the furthest inline nodes in the range.
  const texts = document.getTextsAtRange(range)
  const children = texts.map(text => document.getFurthestInline(text) || text)

  // Iterate each of the child nodes, wrapping them.
  children.forEach((child) => {
    const wrapper = Inline.create({
      nodes: [child],
      type: properties.type,
      data: properties.data
    })

    // Replace the child in it's parent with the wrapper.
    const parent = document.getParent(child)
    const nodes = parent.nodes.takeUntil(n => n == child)
      .push(wrapper)
      .concat(parent.nodes.skipUntil(n => n == child).rest())

    // Update the parent.
    document = parent == document
      ? document.merge({ nodes })
      : document.updateDescendant(parent.merge({ nodes }))
  })

  document = document.normalize()
  state = state.merge({ document })
  transform.state = state
  return transform
}

/**
 * Wrap the text in a `range` in a prefix/suffix.
 *
 * @param {Transform} transform
 * @param {Selection} range
 * @param {String} prefix
 * @param {String} suffix
 * @return {Transform}
 */

export function wrapTextAtRange(transform, range, prefix, suffix = prefix) {
  let { state } = transform
  // Insert text at the starting edge.
  const { startKey, endKey } = range
  const start = range.collapseToStart()
  transform = insertTextAtRange(transform, start, prefix)

  // Determine the new ending edge, and insert text there.
  let end = range.collapseToEnd()
  if (startKey == endKey) end = end.moveForward(prefix.length)
  transform = insertTextAtRange(transform, end, suffix)
  return transform
}