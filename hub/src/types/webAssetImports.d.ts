declare module '../../../web/dist/*' {
    const sourcePath: string;
    export default sourcePath;
}

declare module '../../../web/dist/assets/*' {
    const sourcePath: string;
    export default sourcePath;
}

// Staged root/Beta builds use the same Bun file-import contract as web/dist.
declare module '../../../web/dist-*' {
    const sourcePath: string;
    export default sourcePath;
}
