/**
 * Login page logic for the Antigravity Console.
 *
 * Flow:
 *  1. On load, ask the server whether a password is required (and whether any
 *     password already stored in localStorage is still valid). If no password
 *     is required, or a valid one is already stored, redirect straight to the
 *     dashboard.
 *  2. On submit, POST the password to /api/auth/login. On success, persist it
 *     to localStorage (same key the dashboard reads) and redirect.
 *
 * The stored key matches the dashboard's store: 'antigravity_webui_password'.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'antigravity_webui_password';
    var DASHBOARD_URL = 'index.html';

    var form = document.getElementById('login-form');
    var passwordInput = document.getElementById('password');
    var submitBtn = document.getElementById('submit');
    var submitLabel = document.getElementById('submit-label');
    var spinner = document.getElementById('spinner');
    var errorBox = document.getElementById('error');
    var errorText = document.getElementById('error-text');
    var toggleBtn = document.getElementById('toggle');

    function showError(message) {
        errorText.textContent = message || 'Invalid password';
        errorBox.classList.add('show');
    }

    function clearError() {
        errorBox.classList.remove('show');
    }

    function setLoading(loading) {
        submitBtn.disabled = loading;
        spinner.hidden = !loading;
        submitLabel.textContent = loading ? 'Verifying…' : 'Unlock Dashboard';
    }

    function goToDashboard() {
        window.location.replace(DASHBOARD_URL);
    }

    // Toggle password visibility.
    toggleBtn.addEventListener('click', function () {
        var isPwd = passwordInput.type === 'password';
        passwordInput.type = isPwd ? 'text' : 'password';
        toggleBtn.setAttribute('aria-label', isPwd ? 'Hide password' : 'Show password');
        passwordInput.focus();
    });

    // Step 1: check whether we even need to show this page.
    (function checkStatus() {
        var stored = '';
        try {
            stored = localStorage.getItem(STORAGE_KEY) || '';
        } catch (e) {
            stored = '';
        }

        var headers = {};
        if (stored) {
            headers['x-webui-password'] = stored;
        }

        fetch('/api/auth/status', { headers: headers })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (!data) return;
                // No password configured, or a stored password is already valid.
                if (!data.required || data.authenticated) {
                    goToDashboard();
                }
            })
            .catch(function () {
                /* Network error — stay on the login page and let the user try. */
            });
    })();

    // Step 2: handle submit.
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        clearError();

        var password = passwordInput.value;
        if (!password) {
            showError('Please enter a password.');
            passwordInput.focus();
            return;
        }

        setLoading(true);

        fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password })
        })
            .then(function (res) {
                return res.json().then(function (data) {
                    return { ok: res.ok, status: res.status, data: data };
                });
            })
            .then(function (result) {
                if (result.ok && result.data && result.data.authenticated) {
                    try {
                        localStorage.setItem(STORAGE_KEY, password);
                    } catch (e) {
                        /* localStorage unavailable — proceed anyway. */
                    }
                    goToDashboard();
                    return;
                }
                setLoading(false);
                if (result.status === 401) {
                    showError('Incorrect password. Please try again.');
                } else {
                    showError((result.data && result.data.error) || 'Login failed. Please try again.');
                }
                passwordInput.select();
                passwordInput.focus();
            })
            .catch(function () {
                setLoading(false);
                showError('Could not reach the server. Please try again.');
            });
    });
})();
