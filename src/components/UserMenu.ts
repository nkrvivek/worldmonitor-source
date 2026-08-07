/**
 * The signed-in avatar and its dropdown.
 *
 * Clerk hosted this as `mountUserButton`. Supabase has no such widget, so the
 * button, the menu and the sign-out action live here. The API is the same shape
 * the header already used — mount into an element, get an unmount function back
 * — so `AuthHeaderWidget` only changes its import.
 */

import { getCurrentUser, signOut, subscribeAuth } from '@/services/auth';

export interface UserButtonMenuActions {
  onBillingClick?: () => void;
  onSettingsClick?: () => void;
}

type MenuIconKind = 'billing' | 'settings';

export interface AccountMenuItem {
  label: string;
  onClick: () => void;
  mountIcon: (el: HTMLElement) => void;
  unmountIcon: (el: HTMLElement | null) => void;
}

/**
 * Draw a menu icon. Decorative only: `aria-hidden` keeps it out of the
 * accessibility tree, where the label already says what the item does.
 */
function mountMenuIcon(el: HTMLElement, kind: MenuIconKind): void {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const paths = kind === 'billing'
    ? [
        'M3 6h18v12H3z',
        'M3 10h18',
        'M7 15h3',
      ]
    : [
        'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
        'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z',
      ];
  for (const d of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  el.replaceChildren(svg);
}

/**
 * The account menu, minus sign-out. An action with no handler is left out
 * rather than rendered dead — the header passes handlers only for destinations
 * the current page can actually reach.
 */
export function createAccountMenuItems(actions: UserButtonMenuActions): AccountMenuItem[] {
  const items: AccountMenuItem[] = [];
  if (actions.onBillingClick) {
    items.push({
      label: 'Plan & billing',
      onClick: actions.onBillingClick,
      mountIcon: (el) => mountMenuIcon(el, 'billing'),
      unmountIcon: (el) => el?.replaceChildren(),
    });
  }
  if (actions.onSettingsClick) {
    items.push({
      label: 'Settings',
      onClick: actions.onSettingsClick,
      mountIcon: (el) => mountMenuIcon(el, 'settings'),
      unmountIcon: (el) => el?.replaceChildren(),
    });
  }
  return items;
}

/** First letter of the name, or of the email, for the fallback avatar. */
function initialFor(name: string, email: string): string {
  return (name.trim()[0] ?? email.trim()[0] ?? '?').toUpperCase();
}

/**
 * Mount the avatar button into `el`. Returns the unmount function, which
 * removes the listeners and the menu.
 */
export function mountUserButton(
  el: HTMLElement,
  actions: UserButtonMenuActions = {},
): () => void {
  let menu: HTMLElement | null = null;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'user-menu-button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');

  const wrapper = document.createElement('div');
  wrapper.className = 'user-menu';
  wrapper.appendChild(button);
  el.replaceChildren(wrapper);

  function renderButton(): void {
    const user = getCurrentUser();
    if (!user) {
      button.replaceChildren();
      button.setAttribute('aria-label', 'Account');
      return;
    }
    button.setAttribute('aria-label', `Account: ${user.name}`);
    button.title = user.email || user.name;
    if (user.image) {
      const img = document.createElement('img');
      img.className = 'user-menu-avatar';
      img.src = user.image;
      img.alt = '';
      // A dead avatar URL from the identity provider must not leave an empty
      // button, so fall back to the initial.
      img.addEventListener('error', () => {
        const span = document.createElement('span');
        span.className = 'user-menu-avatar user-menu-avatar-initial';
        span.textContent = initialFor(user.name, user.email);
        button.replaceChildren(span);
      }, { once: true });
      button.replaceChildren(img);
      return;
    }
    const span = document.createElement('span');
    span.className = 'user-menu-avatar user-menu-avatar-initial';
    span.textContent = initialFor(user.name, user.email);
    button.replaceChildren(span);
  }

  function closeMenu(): void {
    menu?.remove();
    menu = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onDocumentKeydown, true);
  }

  function onDocumentClick(e: MouseEvent): void {
    if (!wrapper.contains(e.target as Node)) closeMenu();
  }

  function onDocumentKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    closeMenu();
    button.focus();
  }

  function openMenu(): void {
    const user = getCurrentUser();
    if (!user) return;
    menu = document.createElement('div');
    menu.className = 'user-menu-dropdown';
    menu.setAttribute('role', 'menu');

    const identity = document.createElement('div');
    identity.className = 'user-menu-identity';
    const nameEl = document.createElement('div');
    nameEl.className = 'user-menu-name';
    nameEl.textContent = user.name;
    const emailEl = document.createElement('div');
    emailEl.className = 'user-menu-email';
    emailEl.textContent = user.email;
    identity.append(nameEl, emailEl);
    menu.appendChild(identity);

    for (const item of createAccountMenuItems(actions)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'user-menu-item';
      row.setAttribute('role', 'menuitem');
      const icon = document.createElement('span');
      icon.className = 'user-menu-item-icon';
      item.mountIcon(icon);
      const label = document.createElement('span');
      label.textContent = item.label;
      row.append(icon, label);
      row.addEventListener('click', () => {
        closeMenu();
        item.onClick();
      });
      menu.appendChild(row);
    }

    const signOutRow = document.createElement('button');
    signOutRow.type = 'button';
    signOutRow.className = 'user-menu-item user-menu-signout';
    signOutRow.setAttribute('role', 'menuitem');
    signOutRow.textContent = 'Sign out';
    signOutRow.addEventListener('click', () => {
      closeMenu();
      void signOut();
    });
    menu.appendChild(signOutRow);

    wrapper.appendChild(menu);
    button.setAttribute('aria-expanded', 'true');
    // Capture phase, so a click on a panel that stops propagation still closes
    // the menu.
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onDocumentKeydown, true);
    (menu.querySelector('.user-menu-item') as HTMLElement | null)?.focus();
  }

  button.addEventListener('click', () => {
    if (menu) closeMenu();
    else openMenu();
  });

  renderButton();
  // The name or avatar can arrive after mount — a page load restores the
  // session asynchronously, and an OAuth return fills in the picture later.
  const unsubscribe = subscribeAuth(() => {
    renderButton();
    if (menu) {
      closeMenu();
      openMenu();
    }
  });

  return () => {
    unsubscribe();
    closeMenu();
    el.replaceChildren();
  };
}
