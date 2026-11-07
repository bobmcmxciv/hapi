import type { Root } from 'mdast'
import type { Processor } from 'unified'
import remarkMath from 'remark-math'

interface MarkdownNode {
    type: string
    value?: string
    children?: MarkdownNode[]
}

/** Single-dollar math uses Pandoc-style boundaries so currency stays prose. */
export default function remarkChatFormatting(this: Processor) {
    remarkMath.call(this, { singleDollarTextMath: true })
    const extension = this.data().micromarkExtensions?.at(-1)
    const constructs = extension?.text?.[36]
    const construct = Array.isArray(constructs) ? constructs[0] : constructs
    if (construct) {
        const tokenize = construct.tokenize
        construct.tokenize = function (effects, ok, nok) {
            return tokenize.call(this, effects, (code) => {
                const token = this.events.at(-1)?.[1]
                const raw = token ? this.sliceSerialize(token) : ''
                if (raw.startsWith('$') && !raw.startsWith('$$')
                    && (/\s/.test(raw[1] ?? '') || /\s/.test(raw.at(-2) ?? '')
                        || (code !== null && code >= 48 && code <= 57))) {
                    return nok(code)
                }
                return ok(code)
            }, nok)
        }
    }

    function replaceBreaks(node: MarkdownNode): void {
        if (!node.children) return
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i]
            // Allow only a bare break tag; never enable raw HTML or attributes.
            if (child.type === 'html' && /^<br\s*\/?>$/i.test(child.value ?? '')) {
                node.children[i] = { type: 'break' }
            } else {
                replaceBreaks(child)
            }
        }
    }

    return (tree: Root): void => replaceBreaks(tree)
}
