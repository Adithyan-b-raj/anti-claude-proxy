/**
 * API Keys Manager Component
 *
 * Manages client-facing API keys via the /api/keys endpoints.
 * Registers itself to window.Components for Alpine.js to consume.
 */
window.Components = window.Components || {};

window.Components.apiKeysManager = () => ({
    keys: [],
    authEnforced: false,
    loaded: false,
    creating: false,
    newLabel: '',
    createdKey: '', // full key shown once after creation
    usage: {}, // keyId -> { inputTokens, outputTokens, totalTokens, requests, lastUsed }
    revealed: {}, // keyId -> full key string (populated on demand via the eye button)
    revealing: {}, // keyId -> true while a reveal request is in flight

    init() {
        // Fetch when this sub-tab is active, and whenever the user switches to it.
        if (this.$store.global.settingsTab === 'apikeys') {
            this.fetchKeys();
        }
        this.$watch('$store.global.settingsTab', (tab, oldTab) => {
            if (tab === 'apikeys' && oldTab !== undefined) {
                this.fetchKeys();
            }
        });
    },

    async fetchKeys() {
        const store = Alpine.store('global');
        try {
            const [keysRes, usageRes] = await Promise.all([
                window.utils.request('/api/keys', {}, store.webuiPassword),
                window.utils.request('/api/keys/usage', {}, store.webuiPassword)
            ]);
            if (keysRes.newPassword) store.webuiPassword = keysRes.newPassword;
            if (!keysRes.response.ok) throw new Error('Failed to fetch keys');
            const data = await keysRes.response.json();
            this.keys = data.keys || [];
            this.authEnforced = !!data.authEnforced;

            // Usage is best-effort; don't fail the whole view if it errors.
            try {
                if (usageRes.response.ok) {
                    const udata = await usageRes.response.json();
                    this.usage = udata.usage || {};
                }
            } catch (_) { /* ignore usage errors */ }

            this.loaded = true;
        } catch (e) {
            console.error('Failed to fetch API keys:', e);
            store.showToast(store.t('apiKeysFetchFailed'), 'error');
        }
    },

    // Usage lookup for a given key row.
    usageFor(id) {
        return this.usage[id] || { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, lastUsed: null };
    },

    // Compact number formatting (e.g. 12.3K, 4.5M).
    fmtTokens(n) {
        const v = Number(n) || 0;
        if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(v);
    },

    // Whether a given key's full secret is currently revealed in the UI.
    isRevealed(id) {
        return !!this.revealed[id];
    },

    // The string to render for a key row: full secret when revealed, else masked.
    displayKey(k) {
        return this.revealed[k.id] || k.keyPreview;
    },

    // Toggle reveal for a key. Hiding is instant; revealing fetches the full
    // secret on demand from the password-protected /reveal endpoint (the list
    // response only ever contains the masked preview).
    async toggleReveal(k) {
        if (this.revealed[k.id]) {
            // Hide: drop the cached secret from memory.
            const next = { ...this.revealed };
            delete next[k.id];
            this.revealed = next;
            return;
        }
        if (this.revealing[k.id]) return; // already fetching
        const store = Alpine.store('global');
        this.revealing = { ...this.revealing, [k.id]: true };
        try {
            const { response, newPassword } = await window.utils.request(
                `/api/keys/${k.id}/reveal`, {}, store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to reveal key');
            }
            const data = await response.json();
            this.revealed = { ...this.revealed, [k.id]: data.key };
        } catch (e) {
            store.showToast(store.t('apiKeysRevealFailed') + ': ' + e.message, 'error');
        } finally {
            const next = { ...this.revealing };
            delete next[k.id];
            this.revealing = next;
        }
    },

    // Copy a specific key's full secret (revealing it first if needed).
    async copyKey(k) {
        const store = Alpine.store('global');
        try {
            let secret = this.revealed[k.id];
            if (!secret) {
                const { response, newPassword } = await window.utils.request(
                    `/api/keys/${k.id}/reveal`, {}, store.webuiPassword
                );
                if (newPassword) store.webuiPassword = newPassword;
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || 'Failed to reveal key');
                }
                secret = (await response.json()).key;
            }
            await navigator.clipboard.writeText(secret);
            store.showToast(store.t('apiKeysCopied'), 'success');
        } catch (e) {
            store.showToast(store.t('apiKeysCopyFailed'), 'error');
        }
    },

    async createKey() {
        if (this.creating) return;
        const store = Alpine.store('global');
        this.creating = true;
        try {
            const { response, newPassword } = await window.utils.request('/api/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: this.newLabel || '' })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to create key');
            }
            const data = await response.json();
            this.createdKey = data.key;
            this.newLabel = '';
            store.showToast(store.t('apiKeysCreatedToast'), 'success');
            await this.fetchKeys();
        } catch (e) {
            store.showToast(store.t('apiKeysCreateFailed') + ': ' + e.message, 'error');
        } finally {
            this.creating = false;
        }
    },

    copyCreatedKey() {
        const store = Alpine.store('global');
        if (!this.createdKey) return;
        navigator.clipboard.writeText(this.createdKey)
            .then(() => store.showToast(store.t('apiKeysCopied'), 'success'))
            .catch(() => store.showToast(store.t('apiKeysCopyFailed'), 'error'));
    },

    dismissCreatedKey() {
        this.createdKey = '';
    },

    async toggleKey(key) {
        const store = Alpine.store('global');
        const desired = !key.enabled;
        try {
            const { response, newPassword } = await window.utils.request(`/api/keys/${key.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: desired })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to update key');
            }
            await this.fetchKeys();
        } catch (e) {
            store.showToast(store.t('apiKeysUpdateFailed') + ': ' + e.message, 'error');
            // Re-sync UI with server truth on failure.
            await this.fetchKeys();
        }
    },

    async revokeKey(key) {
        const store = Alpine.store('global');
        const label = key.label || store.t('apiKeysUnlabeled');
        if (!confirm(store.t('apiKeysRevokeConfirm', { label }))) return;
        try {
            const { response, newPassword } = await window.utils.request(`/api/keys/${key.id}`, {
                method: 'DELETE'
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to revoke key');
            }
            store.showToast(store.t('apiKeysRevokedToast'), 'success');
            await this.fetchKeys();
        } catch (e) {
            store.showToast(store.t('apiKeysRevokeFailed') + ': ' + e.message, 'error');
        }
    }
});
