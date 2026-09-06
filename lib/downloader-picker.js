// downloader-picker.js — 自定义下拉框组件
// 用于替换原生 <select>，消除不同系统/浏览器上的原生控件差异。
// 目前驱动两个实例：下载器选择（带图标）与界面语言选择（纯文本）。
// 原生 select 仍保留在 DOM 中作为值载体，程序化读写与既有事件监听不受影响。
(function initCustomPicker(global) {
  const DEFAULT_LOGO = global.PopupUI?.DEFAULT_HEADER_LOGO || 'icons/icon48.png';
  const DOWNLOADER_ICONS = {
    aria2: DEFAULT_LOGO,
    motrixnext: 'assets/provider-icons/motrixnext.png',
    gopeed: 'assets/provider-icons/gopeed.png',
    abdownload: 'assets/provider-icons/abdownload.png',
    neatdm: 'assets/provider-icons/neatdm.png',
  };
  const CHECK_MARK = '✓';

  function createCustomPicker(config) {
    const {
      selectId,
      rootId,
      controlId,
      labelId,
      menuId,
      iconId = null,
      icons = null,
      defaultIcon = DEFAULT_LOGO,
    } = config || {};

    let pickerRoot = null;
    let control = null;
    let iconEl = null;
    let labelEl = null;
    let menuEl = null;
    let nativeSelect = null;
    let optionElements = [];
    let activeIndex = -1;
    let isOpen = false;

    function closeMenu({ restoreFocus = false } = {}) {
      if (!isOpen) return;
      isOpen = false;
      pickerRoot.classList.remove('open');
      menuEl.classList.remove('open');
      menuEl.hidden = true;
      control.setAttribute('aria-expanded', 'false');
      if (restoreFocus) control.focus();
    }

    function computeMenuPlacement() {
      const controlRect = control?.getBoundingClientRect?.();
      if (!controlRect || typeof controlRect.left !== 'number') return null;
      const viewportHeight = global.innerHeight || document.documentElement?.clientHeight || 560;
      const estimatedHeight = menuEl?.offsetHeight || 240;
      const spaceBelow = viewportHeight - controlRect.bottom - 4;
      const spaceAbove = controlRect.top - 4;
      const openUp = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      const menuHeight = Math.min(estimatedHeight, (openUp ? spaceAbove : spaceBelow) - 4);
      const top = openUp
        ? Math.max(8, controlRect.top - menuHeight - 4)
        : controlRect.bottom + 4;
      return {
        left: Math.round(controlRect.left),
        top: Math.round(top),
        width: Math.round(controlRect.width),
        maxHeight: Math.max(60, Math.min(240, (openUp ? spaceAbove : spaceBelow) - 4)),
      };
    }

    function applyPlacement() {
      const placement = computeMenuPlacement();
      if (!placement) return;
      menuEl.style.maxHeight = `${placement.maxHeight}px`;
      menuEl.style.setProperty('--downloader-picker-menu-left', `${placement.left}px`);
      menuEl.style.setProperty('--downloader-picker-menu-top', `${placement.top}px`);
      menuEl.style.setProperty('--downloader-picker-menu-width', `${placement.width}px`);
    }

    function scrollActiveOptionIntoView(item) {
      if (!item) return;
      const menuRect = menuEl.getBoundingClientRect?.();
      const itemRect = item.getBoundingClientRect?.();
      if (!menuRect || !itemRect) return;
      // 只滚动菜单自身，避免把设置面板/弹窗一起带跑导致定位错位
      if (itemRect.top < menuRect.top) {
        menuEl.scrollTop += itemRect.top - menuRect.top;
      } else if (itemRect.bottom > menuRect.bottom) {
        menuEl.scrollTop += itemRect.bottom - menuRect.bottom;
      }
    }

    function setActiveIndex(index) {
      if (index < 0 || index >= optionElements.length) return;
      activeIndex = index;
      optionElements.forEach((el, i) => {
        if (i === index) {
          el.classList.add('active');
          scrollActiveOptionIntoView(el);
        } else {
          el.classList.remove('active');
        }
      });
      control.setAttribute('aria-activedescendant', optionElements[index].id || '');
    }

    function currentIcon(value) {
      return icons ? (icons[value] || defaultIcon) : null;
    }

    function syncLabels() {
      // 从原生 select 重新读取文案，兼容运行时 i18n 更新
      optionElements.forEach((el) => {
        const option = Array.from(nativeSelect.options).find((o) => o.value === el.dataset.value);
        const itemLabel = option ? el.querySelector('.downloader-picker__label') : null;
        if (option && itemLabel) itemLabel.textContent = option.textContent;
      });
      const selected = Array.from(nativeSelect.options).find((o) => o.value === nativeSelect.value);
      if (selected && labelEl) labelEl.textContent = selected.textContent;
    }

    function sync(value) {
      if (!nativeSelect) return;
      const values = Array.from(nativeSelect.options).map((option) => option.value);
      if (values.length !== optionElements.length || values.some((value, index) => value !== optionElements[index]?.dataset.value)) {
        closeMenu();
        buildOptions();
      }
      if (value && nativeSelect.value !== value) nativeSelect.value = value;
      const iconSrc = currentIcon(nativeSelect.value);
      if (iconEl && iconSrc) iconEl.src = iconSrc;
      syncLabels();
      optionElements.forEach((el) => {
        const isSelected = el.dataset.value === nativeSelect.value;
        el.classList.toggle('selected', isSelected);
        el.setAttribute('aria-selected', String(isSelected));
      });
      const selectedIndex = optionElements.findIndex((el) => el.dataset.value === nativeSelect.value);
      if (selectedIndex >= 0) setActiveIndex(selectedIndex);
    }

    function openMenu() {
      if (isOpen || !optionElements.length) return;
      syncLabels();
      isOpen = true;
      pickerRoot.classList.add('open');
      menuEl.classList.add('open');
      menuEl.hidden = false;
      applyPlacement();
      // 布局稳定后再对齐一次，避免首帧布局/滚动导致错位
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(applyPlacement);
      }
      control.setAttribute('aria-expanded', 'true');
      const selectedIndex = optionElements.findIndex((el) => el.dataset.value === nativeSelect.value);
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }

    function selectValue(value) {
      if (!value || nativeSelect.value === value) {
        closeMenu({ restoreFocus: true });
        return;
      }
      nativeSelect.value = value;
      sync();
      closeMenu({ restoreFocus: true });
      nativeSelect.dispatchEvent?.(new global.Event('change', { bubbles: true }));
    }

    function handleControlKeydown(event) {
      const key = event.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        if (!isOpen) {
          openMenu();
          return;
        }
        const direction = key === 'ArrowDown' ? 1 : -1;
        setActiveIndex(Math.min(optionElements.length - 1, Math.max(0, activeIndex + direction)));
        return;
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        if (isOpen && activeIndex >= 0) {
          selectValue(optionElements[activeIndex].dataset.value);
        } else {
          openMenu();
        }
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        closeMenu({ restoreFocus: true });
        return;
      }
      if (key === 'Home' || key === 'End') {
        if (!isOpen) return;
        event.preventDefault();
        setActiveIndex(key === 'Home' ? 0 : optionElements.length - 1);
        return;
      }
      if (key === 'Tab') {
        closeMenu();
      }
    }

    function buildOptions() {
      const options = Array.from(nativeSelect.options || []);
      menuEl.replaceChildren?.();
      optionElements = options.map((option, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'downloader-picker__option';
        item.id = `${rootId}Option${index}`;
        item.dataset.value = option.value;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', 'false');

        const iconSrc = currentIcon(option.value);
        if (iconSrc) {
          const itemIcon = document.createElement('img');
          itemIcon.className = 'downloader-picker__icon';
          itemIcon.src = iconSrc;
          itemIcon.alt = '';
          itemIcon.setAttribute('aria-hidden', 'true');
          itemIcon.addEventListener('error', () => {
            if (itemIcon.src.endsWith(defaultIcon)) return;
            itemIcon.src = defaultIcon;
          });
          item.appendChild(itemIcon);
        }

        const check = document.createElement('span');
        check.className = 'downloader-picker__option-check';
        check.textContent = CHECK_MARK;
        check.setAttribute('aria-hidden', 'true');

        const itemLabel = document.createElement('span');
        itemLabel.className = 'downloader-picker__label';
        itemLabel.textContent = option.textContent;

        item.appendChild(itemLabel);
        item.appendChild(check);

        item.addEventListener('click', () => selectValue(option.value));
        item.addEventListener('mousemove', () => setActiveIndex(index));
        menuEl.appendChild(item);
        return item;
      });
    }

    function init() {
      nativeSelect = document.getElementById(selectId);
      pickerRoot = document.getElementById(rootId);
      control = document.getElementById(controlId);
      labelEl = document.getElementById(labelId);
      menuEl = document.getElementById(menuId);
      if (iconId) iconEl = document.getElementById(iconId);
      // 测试/异常环境（无真实 select options）直接跳过，保持既有逻辑可用
      if (!nativeSelect || !nativeSelect.options || !pickerRoot || !control || !menuEl) return null;

      buildOptions();
      sync();
      // .settings-group 带 backdrop-filter，会把 fixed 定位的后代当成包含块，
      // 导致菜单按卡片坐标偏移。把菜单挂到 body 下可恢复以弹窗视口为基准的定位。
      document.body?.appendChild?.(menuEl);

      control.addEventListener('click', (event) => {
        event.stopPropagation();
        if (isOpen) {
          closeMenu();
        } else {
          openMenu();
        }
      });
      control.addEventListener('keydown', handleControlKeydown);
      menuEl.addEventListener('mousedown', (event) => event.preventDefault());
      document.addEventListener('click', (event) => {
        if (!pickerRoot.contains?.(event.target) && !menuEl.contains?.(event.target)) closeMenu();
      });
      document.addEventListener('scroll', () => {
        if (isOpen) applyPlacement();
      }, true);
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeMenu();
      });

      return { sync };
    }

    return init();
  }

  const downloaderPicker = createCustomPicker({
    selectId: 'cfgDownloaderType',
    rootId: 'downloaderPicker',
    controlId: 'downloaderPickerButton',
    iconId: 'downloaderPickerIcon',
    labelId: 'downloaderPickerLabel',
    menuId: 'downloaderPickerMenu',
    icons: DOWNLOADER_ICONS,
  });
  global.syncDownloaderPicker = (value) => downloaderPicker?.sync(value);

  const languagePicker = createCustomPicker({
    selectId: 'cfgLanguage',
    rootId: 'languagePicker',
    controlId: 'languagePickerButton',
    iconId: null,
    labelId: 'languagePickerLabel',
    menuId: 'languagePickerMenu',
    icons: null,
  });
  global.syncLanguagePicker = (value) => languagePicker?.sync(value);
  const aria2ProfilePicker = createCustomPicker({
    selectId: 'cfgAria2Profile',
    rootId: 'aria2ProfilePicker',
    controlId: 'aria2ProfilePickerButton',
    labelId: 'aria2ProfilePickerLabel',
    menuId: 'aria2ProfilePickerMenu',
  });
  global.syncAria2ProfilePicker = (value) => aria2ProfilePicker?.sync(value);
})(globalThis);
