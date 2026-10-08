import overview from './screens/overview.webp'
import briefing from './screens/briefing.webp'
import card from './screens/card.webp'
import need from './screens/need.webp'
import focus from './screens/focus.webp'
import tabs from './screens/tabs.webp'
import listPrefs from './screens/list-prefs.webp'
import mobileWork from './screens/mobile-work.webp'
import mobileList from './screens/mobile-list.webp'
import workbench from './screens/workbench.webp'

export type HelpSection = {
    id: string
    title: string
    images: Array<{ src: string; alt: string; narrow?: boolean }>
    points: string[]
}

export type HelpContent = { intro: string; note: string; toc: string; sections: HelpSection[] }

const zh: HelpContent = {
    intro: '这里用一套示例数据演示日常怎么用：先在总览看清要做的事，再在待办卡片里直接处理，需要深入时再打开会话。',
    note: '工作总览、梳理待办和工作台目前只对管理员账号显示；会话标签、快捷键和列表外观所有账号都能用。点截图可以打开原图。',
    toc: '目录',
    sections: [
        {
            id: 'overview',
            title: '工作总览：一屏看清全部工作',
            images: [{ src: overview, alt: '工作总览' }],
            points: [
                '在会话页没有打开具体会话时，右侧显示工作总览；手机上点顶部的「工作」。',
                '顶部四个数字依次是：正在推进的主线、需要你处理的事、正在运行的会话、还没归到主线的会话。点任一数字，左侧会话列表只显示对应的会话。',
                '「主线」是长期在做的事（例如「官网与产品」），「支线」是其中一块（例如「会员 App」）；每个项目目录归到一条支线，目录里的会话随之归类。',
                '往下依次是「梳理待办」「需要你处理」和「我的主线」卡片。主线卡片上能看到关联项目、下一步、最近 14 天的活跃度和所用机器。'
            ]
        },
        {
            id: 'briefing',
            title: '梳理待办：一键整理要做的事',
            images: [{ src: briefing, alt: '梳理待办' }],
            points: [
                '点右上角「梳理」，系统读取各主线的进展、等你处理的请求、正在运行和最近两周的会话，整理成四组：需要你拍板/回复、今天推进、可以收尾或归档、停滞提醒。',
                '每组用颜色区分，标题旁是条数；条目前的红点表示优先。',
                '结果会保存，下次打开直接显示。处理完一批事情后再点一次「梳理」即可更新。',
                '点任意一条，会弹出这条事项的待办卡片。'
            ]
        },
        {
            id: 'card',
            title: '待办卡片：不进会话也能处理',
            images: [{ src: card, alt: '待办卡片' }],
            points: [
                '卡片顶部是这条待办的原文和所属主线；这条线有多个会话时，可以在下方切换要处理的会话。',
                '「最新消息」显示会话最近几条问答；「等你处理」里可以直接批准、本会话都批准或拒绝命令，也可以勾选会话提出的选项后提交。',
                '「回复」框里写的话会直接发给这个会话。',
                '会话离线时可以查看和回复，但批准与选项要等它重新在线。「打开会话」跳到完整的会话页面。'
            ]
        },
        {
            id: 'need',
            title: '需要你处理，以及忽略',
            images: [{ src: need, alt: '需要你处理' }],
            points: [
                '列出所有等你批准或回答的会话，以及待整理的新目录、很久没有动静的主线。点会话条目同样打开待办卡片。',
                '已经在别处解决、但请求还挂着的会话，点右侧「忽略」：它不再出现，也不再计入主线卡片的待审批数，梳理待办会把它当作不需要再关注的事。',
                '列表下方「已忽略 N 个」可以展开，点「恢复」撤销。'
            ]
        },
        {
            id: 'focus',
            title: '按主线聚焦',
            images: [{ src: focus, alt: '按主线聚焦' }],
            points: [
                '点主线卡片的空白处，左侧会话列表只显示这条线的会话，列表顶部出现这条线的详情：目标、正在进行、下一步、最近进展和项目阶段。详情可以折叠，折叠状态会记住。',
                '同时「需要你处理」只显示这条线的事，标题旁出现「只看…」标签；点这个标签或左侧的「清除」恢复全部。'
            ]
        },
        {
            id: 'tabs',
            title: '会话标签与快捷键',
            images: [{ src: tabs, alt: '会话标签' }],
            points: [
                '打开过的会话作为标签留在右侧顶部，位置固定，不会随活动时间上下跳动；最左边的「总览」标签一键回到工作总览。',
                '标签可以固定、拖动排序，中键或 × 关闭，右键可关闭其他标签或右侧标签。',
                'Alt+W（macOS 为 ⌥W）关闭当前标签，Alt+T（⌥T）新建会话。把网页安装成应用（浏览器菜单里的「安装」）后，Ctrl+W / ⌘W 和 Ctrl+T / ⌘T 也可以用；在普通浏览器标签页里这两个组合由浏览器自己处理。',
                '在终端页面里这些快捷键不生效，以免影响终端里的删词等操作。'
            ]
        },
        {
            id: 'list-prefs',
            title: '会话列表外观',
            images: [{ src: listPrefs, alt: '会话列表外观设置' }],
            points: [
                '在「设置 → fork → 会话列表外观」里，可以隐藏不常用的工具栏按钮，例如日历筛选、只看未读。',
                '机器标签有三种排法：两列、紧凑（名称加数量排成一行）、仅图标。',
                '工具栏按钮靠右排列，放不下时向右滑动可以看到其余按钮。'
            ]
        },
        {
            id: 'mobile',
            title: '在手机上使用',
            images: [{ src: mobileWork, alt: '手机：工作视图', narrow: true }, { src: mobileList, alt: '手机：会话列表', narrow: true }],
            points: [
                '顶部「工作 / 会话」切换：「工作」是总览，「会话」是会话列表；切换按钮和工具栏在同一行。',
                '梳理待办、需要你处理和待办卡片在手机上的用法与电脑相同，可以直接回复、批准和选择。'
            ]
        },
        {
            id: 'workbench',
            title: '工作台：整理主线与目录',
            images: [{ src: workbench, alt: '工作台' }],
            points: [
                '总览右上角「工作台」进入，按主线查看脉络、各支线的项目和相关会话，可以新建或调整主线、支线。',
                '「待整理」里把新出现的项目目录归到某条支线；家目录这类混在一起的目录可以按会话逐个归属。'
            ]
        }
    ]
}

const en: HelpContent = {
    intro: 'A walkthrough with sample data: see everything on the overview, handle items in the to-do card, and open a session only when you need the full conversation.',
    note: 'The work overview, briefing and workbench are shown to admin accounts only; session tabs, shortcuts and list appearance work for everyone. Click a screenshot to open it full size.',
    toc: 'Contents',
    sections: [
        {
            id: 'overview',
            title: 'Work overview',
            images: [{ src: overview, alt: 'Work overview' }],
            points: [
                'When no session is open, the right pane shows the work overview; on a phone, tap "Work" at the top.',
                'The four numbers are: mainlines in progress, items waiting on you, running sessions, and sessions not yet filed under a mainline. Click a number to filter the session list.',
                'A mainline is a long-running effort and a subline is one part of it; each project folder belongs to a subline, and its sessions follow.',
                'Below are the briefing, "Needs you" and the mainline cards with projects, next step, 14-day activity and machines.'
            ]
        },
        {
            id: 'briefing',
            title: 'Briefing',
            images: [{ src: briefing, alt: 'Briefing' }],
            points: [
                'Click "Sync" to turn mainline progress, pending requests, running and recent sessions into four groups: decide/reply, move forward today, wrap up or archive, and stalled.',
                'Groups are color-coded with a count; a red dot marks priority.',
                'The result is kept until you sync again.',
                'Click any item to open its to-do card.'
            ]
        },
        {
            id: 'card',
            title: 'To-do card',
            images: [{ src: card, alt: 'To-do card' }],
            points: [
                'The card shows the to-do and its mainline; switch between the line\'s sessions below it.',
                'See the latest messages, approve or deny commands, or pick the options a session asked about.',
                'Text in the reply box is sent straight to the session.',
                'Offline sessions can be read and replied to; approvals wait until they are back online.'
            ]
        },
        {
            id: 'need',
            title: 'Needs you, and ignoring',
            images: [{ src: need, alt: 'Needs you' }],
            points: [
                'Lists sessions waiting for approval or an answer, new folders to file, and quiet mainlines.',
                '"Ignore" hides a session whose request is no longer relevant; it stops counting anywhere and briefings skip it.',
                'Expand "N ignored" to restore.'
            ]
        },
        {
            id: 'focus',
            title: 'Focus on a mainline',
            images: [{ src: focus, alt: 'Mainline focus' }],
            points: [
                'Click the empty area of a mainline card: the session list shows only that line, with a collapsible detail of goal, in-progress work, next steps, recent progress and project stages.',
                '"Needs you" narrows to the same line; clear it from the chip or the list filter.'
            ]
        },
        {
            id: 'tabs',
            title: 'Session tabs and shortcuts',
            images: [{ src: tabs, alt: 'Session tabs' }],
            points: [
                'Opened sessions stay as tabs in a fixed order; the leftmost tab returns to the overview.',
                'Pin, drag, middle-click to close, right-click to close others or tabs to the right.',
                'Alt+W closes the current tab and Alt+T starts a new session. In the installed app, Ctrl/⌘+W and Ctrl/⌘+T work too; in a regular browser tab the browser keeps them.',
                'Shortcuts are ignored inside the terminal.'
            ]
        },
        {
            id: 'list-prefs',
            title: 'List appearance',
            images: [{ src: listPrefs, alt: 'List appearance settings' }],
            points: [
                'Settings → fork → list appearance: hide toolbar buttons you rarely use and choose the machine chip layout (two columns, compact, icons only).',
                'Toolbar buttons align right; swipe to reveal the rest when they do not fit.'
            ]
        },
        {
            id: 'mobile',
            title: 'On a phone',
            images: [{ src: mobileWork, alt: 'Phone: work view', narrow: true }, { src: mobileList, alt: 'Phone: session list', narrow: true }],
            points: [
                'Switch between "Work" and "Sessions" at the top; the switch shares the row with the toolbar.',
                'The briefing, "Needs you" and to-do cards work the same as on a computer.'
            ]
        },
        {
            id: 'workbench',
            title: 'Workbench',
            images: [{ src: workbench, alt: 'Workbench' }],
            points: [
                'Open it from the overview to browse mainlines, their projects and sessions, and to create or edit lines.',
                'File new project folders under a subline in the triage tab; mixed folders can be filed session by session.'
            ]
        }
    ]
}

export function helpContentFor(locale: string): HelpContent {
    return locale === 'zh-CN' ? zh : en
}
