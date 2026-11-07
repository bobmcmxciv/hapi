import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { toHtml } from 'hast-util-to-html'
import {
    MARKDOWN_PLUGINS,
    MARKDOWN_REHYPE_PLUGINS,
} from '@/components/assistant-ui/markdown-text'

function render(markdown: string): string {
    const processor = unified()
        .use(remarkParse)
        .use(MARKDOWN_PLUGINS)
        .use(remarkRehype)
        .use(MARKDOWN_REHYPE_PLUGINS)
    const tree = processor.runSync(processor.parse(markdown))
    return toHtml(tree as never)
}

describe('MARKDOWN_PLUGINS — currency prose vs KaTeX', () => {
    it('does not render single-$ currency amounts as KaTeX math', () => {
        const md = "The plan is $200/mo and the bill is $80 — total $400 saved."
        const html = render(md)
        expect(html).not.toContain('class="katex"')
        expect(html).not.toContain('<math')
        expect(html).toContain('$200')
        expect(html).toContain('$80')
        expect(html).toContain('$400')
    })

    it('does not render the reported real-world prose as KaTeX', () => {
        // Lifted (paraphrased) from the bug report: paragraph with multiple
        // "$N" amounts and apostrophes that previously collapsed into a single
        // KaTeX block and stripped whitespace from the running text.
        const md = "Cursor's UI quotes the ratio: at least $400 of API usage on a $200 plan. That's 2:1."
        const html = render(md)
        expect(html).not.toContain('class="katex"')
        expect(html).not.toContain('<math')
        expect(html).toContain('$400')
        expect(html).toContain('$200')
    })

    it('still renders block math with $$...$$ on its own lines', () => {
        const md = "Before\n\n$$\nE = mc^2\n$$\n\nAfter"
        const html = render(md)
        expect(html).toContain('class="katex"')
    })

    it('renders styled single-dollar LaTeX alongside currency prose', () => {
        const html = render(String.raw`Price $200/mo and $80; result $\textcolor{red}{\textbf{risk}}$ and $\mathbf{4\times}$; $x_i^2$.`)
        expect(html.match(/class="katex"/g)).toHaveLength(3)
        expect(html).toContain('color:red')
        expect(html).not.toContain('katex-error')
        expect(html).toContain('$200/mo and $80')
    })

    it('renders safe HTML line breaks in table cells', () => {
        const html = render('| Item | Detail |\n| --- | --- |\n| A | first<br>second<br/>third<BR />last |')
        const container = document.createElement('div')
        container.innerHTML = html
        const cell = container.querySelector('tbody tr')?.lastElementChild
        expect(cell?.querySelectorAll('br')).toHaveLength(3)
        expect(cell?.textContent?.replaceAll('\n', '')).toBe('firstsecondthirdlast')
    })

    it('keeps formatting examples literal and does not enable arbitrary HTML', () => {
        const html = render('`$x_i$ <br>`\n\n```html\n<br>\n```\n\n<br onclick="alert(1)">\n\n<img src=x onerror="alert(1)">')
        expect(html).toContain('$x_i$ &#x3C;br>')
        expect(html).not.toContain('class="katex"')
        expect(html).not.toContain('<img')
        expect(html).not.toContain('<br onclick')
    })
})
