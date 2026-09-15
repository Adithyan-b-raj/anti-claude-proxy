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
            const { response, newPassword } = await window.utils.request('/api/keys', {}, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            if (!response.ok) throw new Error('Failed to fetch keys');
            const data = await response.json();
            this.keys = data.keys || [];
            this.authEnforced = !!data.authEnforced;
            this.loaded = true;
        } catch (e) {
            console.error('Failed to fetch API keys:', e);
            store.showToast(store.t('apiKeysFetchFailed'), 'error');
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
