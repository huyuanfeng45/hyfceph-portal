const copySkillLinkButton = document.querySelector('#copy-skill-link-button');

copySkillLinkButton?.addEventListener('click', async () => {
  const value = String(copySkillLinkButton.dataset.copyText || '').trim();
  if (!value) {
    return;
  }

  const originalText = copySkillLinkButton.textContent;
  try {
    await navigator.clipboard.writeText(value);
    copySkillLinkButton.textContent = '已复制技能名';
    window.setTimeout(() => {
      copySkillLinkButton.textContent = originalText;
    }, 1600);
  } catch {
    copySkillLinkButton.textContent = '复制失败';
    window.setTimeout(() => {
      copySkillLinkButton.textContent = originalText;
    }, 1600);
  }
});
