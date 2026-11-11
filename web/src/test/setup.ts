import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
    cleanup()
})

function installMemoryLocalStorage(): void {
    const store = new Map<string, string>()
    const proto = typeof Storage !== 'undefined' && Storage.prototype ? Storage.prototype : Object.prototype
    const methods = {
        clear() {
            store.clear()
        },
        getItem(key: string) {
            return store.get(String(key)) ?? null
        },
        key(index: number) {
            return Array.from(store.keys())[index] ?? null
        },
        removeItem(key: string) {
            store.delete(String(key))
        },
        setItem(key: string, value: string) {
            store.set(String(key), String(value))
        }
    }
    if (typeof Storage !== 'undefined' && Storage.prototype) {
        Object.assign(Storage.prototype, methods)
        Object.defineProperty(Storage.prototype, 'length', {
            get() {
                return store.size
            },
            configurable: true
        })
    }
    const memoryLocalStorage = Object.create(proto) as Storage
    if (typeof Storage === 'undefined' || !Storage.prototype) {
        Object.assign(memoryLocalStorage, methods)
        Object.defineProperty(memoryLocalStorage, 'length', {
            get() {
                return store.size
            },
            configurable: true
        })
    }
    Object.defineProperty(globalThis, 'localStorage', {
        value: memoryLocalStorage,
        configurable: true
    })
    Object.defineProperty(window, 'localStorage', {
        value: memoryLocalStorage,
        configurable: true
    })
}

try {
    const storage = globalThis.localStorage
    if (
        typeof storage?.getItem !== 'function'
        || typeof storage.setItem !== 'function'
        || typeof storage.removeItem !== 'function'
        || typeof storage.clear !== 'function'
    ) {
        installMemoryLocalStorage()
    }
} catch {
    installMemoryLocalStorage()
}

if (!('IntersectionObserver' in globalThis)) {
    class MockIntersectionObserver implements IntersectionObserver {
        readonly root = null
        readonly rootMargin = ''
        readonly scrollMargin = ''
        readonly thresholds = []

        disconnect() { }
        observe() { }
        takeRecords(): IntersectionObserverEntry[] { return [] }
        unobserve() { }
    }

    Object.defineProperty(globalThis, 'IntersectionObserver', {
        value: MockIntersectionObserver,
        configurable: true
    })
    Object.defineProperty(window, 'IntersectionObserver', {
        value: MockIntersectionObserver,
        configurable: true
    })
}

if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener() { },
            removeListener() { },
            addEventListener() { },
            removeEventListener() { },
            dispatchEvent() { return false },
        }),
    })
}
