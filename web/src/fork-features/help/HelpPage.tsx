import { SettingsPageContent } from '@/components/settings/SettingsPrimitives'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import { helpContentFor } from './helpContent'

/** 设置 → 使用指南：用示例数据截图说明总览、待办卡片、主线聚焦、标签快捷键等整套用法。 */
export default function HelpPage() {
    const { t, locale } = useTranslation()
    const content = helpContentFor(locale)
    return (
        <SettingsPageContent title={t('settings.help.title')} description={content.intro}>
            <div data-testid="help-page" className="space-y-8 pb-10">
                <p className="rounded-xl bg-[var(--app-subtle-bg)] px-4 py-3 text-sm text-[var(--app-hint)]">{content.note}</p>
                <nav aria-label={content.toc} className="rounded-xl border border-[var(--app-border)] px-4 py-3">
                    <div className="mb-1.5 text-xs font-semibold text-[var(--app-hint)]">{content.toc}</div>
                    <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                        {content.sections.map((section, index) => (
                            <li key={section.id}>
                                <a href={`#help-${section.id}`} className="text-[var(--app-link)] hover:underline">{index + 1}. {section.title}</a>
                            </li>
                        ))}
                    </ol>
                </nav>
                {content.sections.map((section, index) => (
                    <section key={section.id} id={`help-${section.id}`} className="scroll-mt-4">
                        <h2 className="mb-3 text-lg font-bold">{index + 1}. {section.title}</h2>
                        <div className={cn('mb-3 grid gap-3', section.images.length > 1 && 'grid-cols-2')}>
                            {section.images.map(image => (
                                <a key={image.src} href={image.src} target="_blank" rel="noreferrer" className={cn('block', image.narrow && 'mx-auto w-full max-w-[280px]')}>
                                    <img
                                        src={image.src}
                                        alt={image.alt}
                                        loading="lazy"
                                        className="w-full rounded-xl border border-[var(--app-border)] shadow-sm"
                                    />
                                </a>
                            ))}
                        </div>
                        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
                            {section.points.map(point => <li key={point}>{point}</li>)}
                        </ul>
                    </section>
                ))}
            </div>
        </SettingsPageContent>
    )
}
