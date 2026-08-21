document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelectorAll('.browser-btn');
  const steps = document.querySelectorAll('.browser-steps');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Deactivate all tabs
      tabs.forEach(t => t.classList.remove('active'));
      // Activate clicked tab
      tab.classList.add('active');

      // Hide all steps
      steps.forEach(s => s.classList.remove('active'));

      // Show steps for this browser
      const stepId = tab.id.replace('tab-', 'steps-');
      const targetStep = document.getElementById(stepId);
      if (targetStep) {
        targetStep.classList.add('active');
      }
    });
  });
});
