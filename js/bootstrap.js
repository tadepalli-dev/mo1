// bootstrap.js — extracted from app.js (3 declarations)

async function initialize() {
  await bootstrapState();
  restoreRememberedEmail();
  restoreSession();
  populateFilters();
  populateTaskAssigneeOptions();
  populateAbsenceEmployeeOptions();
  setHomeDefaults();
  bindEvents();
  if (state.currentView === "approvals") {
    elements.approvalsDateInput.value = getDefaultApprovalsDateForUser(state.activeUser);
  }
  renderDashboard();
  if (state.activeUser) {
    loadCompanyVehicles().then(renderDashboard);
  }
  loadSheetLeaveData();
  setInterval(loadSheetLeaveData, SHEET_LEAVE_REFRESH_MS);
  setInterval(async () => {
    if (!state.activeUser) {
      return;
    }
    await refreshStateFromServer();
    await loadCompanyVehicles();
    renderDashboard();
  }, SERVER_STATE_REFRESH_MS);
}


function bindEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.logoutButton.addEventListener("click", logout);
  elements.openChangePasswordButton.addEventListener("click", openChangePasswordModal);
  elements.closeChangePasswordModalButton.addEventListener("click", closeChangePasswordModal);
  elements.changePasswordModal.addEventListener("click", handleChangePasswordModalBackdropClick);
  elements.changePasswordForm.addEventListener("submit", handleChangePasswordSubmit);
  elements.openForgotPasswordButton.addEventListener("click", openForgotPasswordModal);
  elements.closeForgotPasswordButton.addEventListener("click", closeForgotPasswordModal);
  elements.forgotPasswordModal.addEventListener("click", handleForgotPasswordModalBackdropClick);
  elements.forgotPasswordForm.addEventListener("submit", handleForgotPasswordSubmit);
  elements.passwordResetRequestsBoard.addEventListener("click", handlePasswordResetAction);
  elements.vehicleWorkflowBoard?.addEventListener("submit", handleVehicleWorkflowSubmit);
  elements.vehicleWorkflowBoard?.addEventListener("click", handleVehicleWorkflowAction);
  elements.vehicleWorkflowBoard?.addEventListener("input", handleVehicleRequestDraftInput);
  bindVehiclePickerEvents(elements.vehicleWorkflowBoard);
  elements.addUserForm.addEventListener("submit", handleAddUser);
  elements.toggleAddUserForm.addEventListener("click", handleToggleAddUserForm);
  elements.pantryAlertsToggle.addEventListener("click", handlePantryAlertsToggle);
  elements.searchInput.addEventListener("input", handleDirectorySearch);
  elements.contactsSearchInput.addEventListener("input", handleContactsSearch);
  elements.roleFilter.addEventListener("change", handleRoleFilterChange);
  elements.dayOffFilter.addEventListener("change", handleDayOffFilterChange);
  elements.dateRangeSelect.addEventListener("change", handleEmployeeTaskFilterChange);
  elements.taskSelect.addEventListener("change", handleEmployeeTaskFilterChange);
  elements.departmentSelect.addEventListener("change", handleEmployeeTaskFilterChange);
  elements.homeSearchInput.addEventListener("input", handleHomeSearch);
  elements.dashboardDateInput.addEventListener("change", handleAdminDateChange);
  elements.pcMonitorDateInput?.addEventListener("change", handlePcMonitorDateChange);
  elements.pcMonitorTabNav?.addEventListener("click", handlePcMonitorTabClick);
  elements.pcDashboardPanel?.addEventListener("submit", handlePcFollowUpSubmit);
  elements.pcDashboardPanel?.addEventListener("toggle", handlePcEmployeeToggle, true);
  elements.closeAssignTaskButton.addEventListener("click", closeAssignTaskModal);
  elements.assignTaskModal.addEventListener("click", handleAssignModalBackdropClick);
  elements.assignTaskForm.addEventListener("submit", handleAssignTask);
  elements.assignTaskUser.addEventListener("change", syncTaskAssignmentFields);
  elements.assignTaskUser.addEventListener("input", syncTaskAssignmentFields);
  elements.absenceForm.addEventListener("submit", handleAbsenceSubmit);
  elements.coverageList.addEventListener("click", handleCoverageAction);
  elements.sidebarToggle.addEventListener("click", toggleSidebar);
  elements.sidebarClose.addEventListener("click", collapseSidebar);
  elements.adminTaskBoard.addEventListener("click", handleAdminTaskAction);
  elements.employeeTaskTableBody.addEventListener("click", handleEmployeeTaskAction);
  elements.employeeTaskTableBody.addEventListener("change", handleEmployeeStatusSelectChange);
  elements.walkinCustomerBoard.addEventListener("click", handleEmployeeTaskAction);
  elements.walkinCustomerBoard.addEventListener("change", handleEmployeeStatusSelectChange);
  elements.closeChecklistButton.addEventListener("click", closeChecklistModal);
  elements.checklistModal.addEventListener("click", handleChecklistModalBackdropClick);
  elements.checklistForm.addEventListener("submit", handleChecklistSubmit);
  elements.checklistFields.addEventListener("click", handleChecklistFieldsClick);
  elements.closeNotCompletedButton.addEventListener("click", closeNotCompletedModal);
  elements.notCompletedModal.addEventListener("click", handleNotCompletedModalBackdropClick);
  elements.notCompletedForm.addEventListener("submit", handleNotCompletedSubmit);
  elements.closeSubmissionDetailsButton.addEventListener("click", closeSubmissionDetailsModal);
  elements.submissionDetailsModal.addEventListener("click", handleSubmissionDetailsModalBackdropClick);
  setupVoiceInput(elements.notCompletedMicButton, elements.notCompletedRemarks, elements.notCompletedVoiceStatus);
  elements.approvalsDateInput.addEventListener("change", handleApprovalsDateChange);
  elements.complianceStartDate.addEventListener("change", handleComplianceDateChange);
  elements.complianceEndDate.addEventListener("change", handleComplianceDateChange);
  elements.resyncSubmissionReportButton.addEventListener("click", handleResyncSubmissionReport);
  elements.pcSubmittedBoard?.addEventListener("click", handleSubmissionDetailsAction);
  elements.approvalsCompletedBoard.addEventListener("click", handleApprovalsAction);
  elements.approvalsCompletedBoard.addEventListener("click", handleSubmissionDetailsAction);
  elements.approvalsNotCompletedBoard.addEventListener("click", handleApprovalsAction);
  elements.approvalsNotCompletedBoard.addEventListener("click", handleSubmissionDetailsAction);
  elements.approvalsApprovedBoard.addEventListener("click", handleSubmissionDetailsAction);
  elements.complianceBoard.addEventListener("click", handleSubmissionDetailsAction);
  elements.kamalApprovalBoard.addEventListener("click", handleKamalApprovalAction);
  elements.fuelApprovalBoard.addEventListener("click", handleFuelRequestApprovalAction);
  elements.arunApprovalBoard.addEventListener("click", handleArunApprovalAction);
  elements.approvalsTabNav.addEventListener("click", handleApprovalsTabClick);
  elements.liveShareBanner.addEventListener("click", handleLiveShareBannerClick);
  document.addEventListener("click", handleGlobalClick);

  elements.navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      const nextView = link.dataset.view;
      if (nextView) {
        setCurrentView(nextView);
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!elements.assignTaskModal.classList.contains("hidden")) {
        closeAssignTaskModal();
      }
      if (!elements.checklistModal.classList.contains("hidden")) {
        closeChecklistModal();
      }
      if (!elements.submissionDetailsModal.classList.contains("hidden")) {
        closeSubmissionDetailsModal();
      }
    }
  });

  window.addEventListener("hashchange", () => {
    // setCurrentView (nav-link clicks) already refreshes from the server and
    // sets this same hash, which would otherwise double the request here.
    // This listener only needs to cover hash changes it didn't cause itself
    // — browser back/forward, or a manually edited URL.
    if (state.currentView === getInitialView()) {
      return;
    }
    state.currentView = getInitialView();
    enforceAllowedView();
    renderDashboard();
    refreshStateFromServer().then(renderDashboard);
  });

  // The Google site-visit form opens in a separate tab. When the employee
  // returns here after its successful save, pull the completed visit from the
  // server and update the open checklist immediately.
  window.addEventListener("focus", () => {
    refreshActiveSiteVisitProgress().catch((error) => {
      console.error("Could not refresh site visit progress.", error);
    });
  });
}


initialize();
