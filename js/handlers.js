// handlers.js — extracted from app.js (36 declarations)

function handleGlobalClick(event) {
  const openAssignTrigger = event.target.closest("[data-open-assign-modal]");
  if (openAssignTrigger) {
    openAssignTaskModal();
    return;
  }

  const passwordToggle = event.target.closest("[data-password-toggle]");
  if (passwordToggle) {
    const input = document.getElementById(passwordToggle.getAttribute("data-password-toggle"));
    if (!input) {
      return;
    }
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    passwordToggle.textContent = isHidden ? "🙈" : "👁";
    passwordToggle.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    return;
  }
}

async function autoFillVehicleFieldsFromLoginEmail(task) {
  const vehicleNumberField = document.getElementById("question-vehicle_number");
  const vehicleTypeField = document.getElementById("question-vehicle_type");
  if (!vehicleNumberField || !vehicleTypeField || !state.activeUser) {
    return;
  }

  const expectedTask = state.activeChecklistTask;
  setStatusMessage(elements.checklistMessage, "Looking up your vehicle from the sheet…", "");

  try {
    const result = await fetchVehicleAssignmentForActiveUser();
    if (state.activeChecklistTask !== expectedTask || state.activeChecklistTask !== task) {
      return;
    }

    if (!result.match) {
      setStatusMessage(
        elements.checklistMessage,
        `No vehicle mapping was found for ${state.activeUser.email}. Enter it manually.`,
        ""
      );
      return;
    }

    if (!vehicleNumberField.value) {
      vehicleNumberField.value = result.match.vehicleNumber;
      vehicleNumberField.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (!vehicleTypeField.value) {
      vehicleTypeField.value = result.match.vehicleType;
      vehicleTypeField.dispatchEvent(new Event("change", { bubbles: true }));
    }

    setStatusMessage(
      elements.checklistMessage,
      `Auto-filled ${result.match.vehicleType.toLowerCase()} details from the ${result.match.sourceLabel} sheet.`,
      "success"
    );
  } catch (error) {
    if (state.activeChecklistTask !== expectedTask || state.activeChecklistTask !== task) {
      return;
    }
    setStatusMessage(
      elements.checklistMessage,
      `Couldn't load vehicle details automatically. ${error.message}`,
      "error"
    );
  }
}


async function handleVehicleWorkflowSubmit(event) {
  const form = event.target.closest("form[data-vehicle-form]");
  if (!form) {
    return;
  }
  event.preventDefault();
  const formType = form.dataset.vehicleForm;
  const requestId = form.dataset.requestId;
  const submitter = event.submitter;
  const body = new FormData(form);
  let url = "";
  let payload = {};

  if (formType === "request") {
    url = "/api/vehicle-change-requests";
    payload = { reason: String(body.get("reason") || "").trim() };
  } else if (formType === "allocate") {
    const decision = submitter?.value === "rejected" ? "rejected" : "approved";
    // The picker holds the raw vehicle number, but a rejection needs no vehicle
    // at all — the server only insists on one when the decision is "approved".
    url = `/api/vehicle-change-requests/${encodeURIComponent(requestId)}/allocate`;
    payload = {
      decision,
      vehicleNumber: String(body.get("vehicleNumber") || "").split(" | ")[0].trim(),
      note: String(body.get("note") || "").trim(),
    };
    if (decision === "approved" && !payload.vehicleNumber) {
      window.alert("Choose a vehicle before approving this request.");
      return;
    }
  } else if (formType === "cash") {
    url = `/api/vehicle-change-requests/${encodeURIComponent(requestId)}/cash`;
    payload = {
      amount: Number(body.get("amount")),
      note: String(body.get("note") || "").trim(),
    };
  } else {
    return;
  }

  // The vehicle-directory lookup behind an allocation can take a few seconds.
  // Without this the buttons stay live throughout, and an impatient second
  // click arrives after the first has already advanced the request - which
  // came back as a confusing "not waiting for a vehicle allocation" error.
  if (form.dataset.submitting === "true") {
    return;
  }
  const buttons = [...form.querySelectorAll("button")];
  const restoreButtons = () => {
    delete form.dataset.submitting;
    buttons.forEach((button) => {
      button.disabled = false;
      if (button.dataset.idleLabel != null) {
        button.textContent = button.dataset.idleLabel;
        delete button.dataset.idleLabel;
      }
    });
  };
  form.dataset.submitting = "true";
  buttons.forEach((button) => {
    button.disabled = true;
  });
  if (submitter) {
    submitter.dataset.idleLabel = submitter.textContent;
    submitter.textContent = "Working...";
  }

  try {
    const response = await fetch(buildApiUrl(url), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
    });
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    const result = await readJsonResponse(response);
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not save the vehicle workflow update.");
    }
    if (formType === "request") {
      state.vehicleRequestFormOpen = false;
      state.vehicleRequestDraft = "";
    }
    await Promise.all([refreshStateFromServer(), loadCompanyVehicles()]);
    // renderDashboard() replaces this form wholesale, so there is nothing left
    // to re-enable on the success path.
    renderDashboard();
  } catch (error) {
    restoreButtons();
    window.alert(error.message || "Could not save the vehicle workflow update.");
  }
}


function handleVehicleWorkflowAction(event) {
  if (event.target.closest("[data-vehicle-request-open]")) {
    state.vehicleRequestFormOpen = true;
    renderVehicleWorkflowPanel();
    elements.vehicleWorkflowBoard.querySelector("[data-vehicle-request-reason]")?.focus();
    return;
  }

  if (event.target.closest("[data-vehicle-request-cancel]")) {
    state.vehicleRequestFormOpen = false;
    state.vehicleRequestDraft = "";
    renderVehicleWorkflowPanel();
  }
}


// The 60-second dashboard refresh re-renders the board from scratch, so the
// reason has to be mirrored onto state as it is typed or it would be lost.
function handleVehicleRequestDraftInput(event) {
  const reason = event.target.closest("[data-vehicle-request-reason]");
  if (reason) {
    state.vehicleRequestDraft = reason.value;
  }
}


// The allocation board is rebuilt with innerHTML on every refresh, so the
// searchable vehicle dropdown is driven by delegation on the board itself
// rather than listeners bound to elements that are about to be replaced.
function bindVehiclePickerEvents(board) {
  if (!board) {
    return;
  }

  const closeAllPickers = (except) => {
    board.querySelectorAll("[data-vehicle-picker]").forEach((picker) => {
      if (picker === except) {
        return;
      }
      picker.querySelector(".vehicle-picker__list")?.classList.add("hidden");
      picker.querySelector(".vehicle-picker__input")?.setAttribute("aria-expanded", "false");
    });
  };

  const filterPicker = (picker) => {
    const input = picker.querySelector(".vehicle-picker__input");
    const list = picker.querySelector(".vehicle-picker__list");
    const term = String(input?.value || "").trim().toLowerCase();
    let visible = 0;
    picker.querySelectorAll(".vehicle-picker__option").forEach((option) => {
      const matches = !term || String(option.dataset.search || "").includes(term);
      option.classList.toggle("hidden", !matches);
      if (matches) {
        visible += 1;
      }
    });
    let emptyRow = list.querySelector(".vehicle-picker__empty--no-match");
    if (!visible) {
      if (!emptyRow) {
        emptyRow = document.createElement("li");
        emptyRow.className = "vehicle-picker__empty vehicle-picker__empty--no-match";
        list.append(emptyRow);
      }
      emptyRow.textContent = `No vehicle matches "${input.value}".`;
      emptyRow.classList.remove("hidden");
    } else if (emptyRow) {
      emptyRow.classList.add("hidden");
    }
  };

  const openPicker = (picker) => {
    closeAllPickers(picker);
    filterPicker(picker);
    picker.querySelector(".vehicle-picker__list")?.classList.remove("hidden");
    picker.querySelector(".vehicle-picker__input")?.setAttribute("aria-expanded", "true");
  };

  board.addEventListener("focusin", (event) => {
    const input = event.target.closest(".vehicle-picker__input");
    if (input) {
      openPicker(input.closest("[data-vehicle-picker]"));
      return;
    }
    closeAllPickers(null);
  });

  board.addEventListener("input", (event) => {
    const input = event.target.closest(".vehicle-picker__input");
    if (input) {
      openPicker(input.closest("[data-vehicle-picker]"));
    }
  });

  // mousedown fires before the input's blur, so the option is still on screen
  // when the selection is read.
  board.addEventListener("mousedown", (event) => {
    const option = event.target.closest(".vehicle-picker__option");
    if (!option) {
      return;
    }
    event.preventDefault();
    const picker = option.closest("[data-vehicle-picker]");
    const input = picker.querySelector(".vehicle-picker__input");
    input.value = option.dataset.vehicleNumber || "";
    picker.querySelector(".vehicle-picker__list")?.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
  });

  board.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.target.closest(".vehicle-picker__input")) {
      closeAllPickers(null);
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-vehicle-picker]")) {
      closeAllPickers(null);
    }
  });
}


async function handleLogin(event) {
  event.preventDefault();

  const email = elements.emailInput.value.trim().toLowerCase();
  const password = elements.passwordInput.value.trim();

  setStatusMessage(elements.loginMessage, "Signing in…", "");

  // Temporary login mode: the server currently authenticates by known email
  // only, then returns a session token for the rest of the app.
  let result;
  try {
    const response = await fetch(buildApiUrl("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    result = await response.json();
  } catch (error) {
    setStatusMessage(elements.loginMessage, "Could not reach the server to sign in. Try again.", "error");
    return;
  }

  if (!result.ok) {
    const messages = {
      not_found: "This email is not in the MoTrack user list.",
      missing_password: "Enter a password to continue.",
      wrong_password: "Password is incorrect for this account.",
    };
    setStatusMessage(elements.loginMessage, messages[result.reason] || "Could not sign in.", "error");
    return;
  }

  saveAuthToken(result.token);
  await refreshStateFromServer();

  state.activeUser = result.user;
  state.pcMonitorDate = todayValue();
  state.currentView = state.currentView === "home" ? getDefaultViewForUser(result.user) : allowedView(state.currentView);
  saveSession(result.user.email);
  saveRememberedEmail();
  toggleViews(true);
  setHomeDefaults();
  renderDashboard();
  loadCompanyVehicles().then(renderDashboard);
  setStatusMessage(elements.loginMessage, `Welcome, ${result.user.name}.`, "success");
}


function openForgotPasswordModal() {
  elements.forgotPasswordForm.reset();
  elements.forgotPasswordMessage.textContent = "";
  elements.forgotPasswordEmail.value = elements.emailInput.value.trim();
  elements.forgotPasswordModal.classList.remove("hidden");
  elements.forgotPasswordModal.setAttribute("aria-hidden", "false");
}


function closeForgotPasswordModal() {
  elements.forgotPasswordModal.classList.add("hidden");
  elements.forgotPasswordModal.setAttribute("aria-hidden", "true");
}


function handleForgotPasswordModalBackdropClick(event) {
  if (event.target === elements.forgotPasswordModal) {
    closeForgotPasswordModal();
  }
}


async function handleForgotPasswordSubmit(event) {
  event.preventDefault();

  const email = elements.forgotPasswordEmail.value.trim().toLowerCase();
  setStatusMessage(elements.forgotPasswordMessage, "Sending request…", "");

  let result;
  try {
    const response = await fetch(buildApiUrl("/api/forgot-password"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    result = await response.json();
  } catch (error) {
    setStatusMessage(elements.forgotPasswordMessage, "Could not reach the server. Try again.", "error");
    return;
  }

  if (!result.ok) {
    const messages = {
      not_found: "This email is not in the MoTrack user list.",
    };
    setStatusMessage(elements.forgotPasswordMessage, messages[result.reason] || "Could not submit the request.", "error");
    return;
  }

  setStatusMessage(elements.forgotPasswordMessage, "Request sent. Asha will reset your password shortly.", "success");
}


function handleAddUser(event) {
  event.preventDefault();

  const email = elements.newUserEmail.value.trim().toLowerCase();
  const alreadyExists = state.users.some((user) => user.email.toLowerCase() === email);
  if (alreadyExists) {
    setStatusMessage(elements.addUserMessage, "A user with this email already exists.", "error");
    return;
  }

  const user = {
    name: elements.newUserName.value.trim(),
    email,
    role: elements.newUserRole.value.trim(),
    designation: elements.newUserDesignation.value.trim() || "-",
    code: elements.newUserCode.value.trim() || "-",
    dayOff: elements.newUserDayOff.value || "-",
    password: elements.newUserPassword.value.trim(),
  };

  state.users.unshift(user);
  saveUsers();
  elements.addUserForm.reset();
  elements.newUserDayOff.value = "-";
  refreshUserViews();
  setStatusMessage(elements.addUserMessage, `${user.name} was added and is now visible in MoTrack.`, "success");
}


function openChangePasswordModal() {
  elements.changePasswordForm.reset();
  elements.changePasswordMessage.textContent = "";
  elements.changePasswordModal.classList.remove("hidden");
  elements.changePasswordModal.setAttribute("aria-hidden", "false");
}


function closeChangePasswordModal() {
  elements.changePasswordModal.classList.add("hidden");
  elements.changePasswordModal.setAttribute("aria-hidden", "true");
}


function handleChangePasswordModalBackdropClick(event) {
  if (event.target === elements.changePasswordModal) {
    closeChangePasswordModal();
  }
}


function handleChangePasswordSubmit(event) {
  event.preventDefault();

  if (!state.activeUser) {
    setStatusMessage(elements.changePasswordMessage, "You must be signed in to change your password.", "error");
    return;
  }

  const newPassword = elements.newPasswordInput.value.trim();
  const confirmPassword = elements.confirmNewPasswordInput.value.trim();

  if (newPassword.length < 6) {
    setStatusMessage(elements.changePasswordMessage, "Password must be at least 6 characters.", "error");
    return;
  }

  if (newPassword !== confirmPassword) {
    setStatusMessage(elements.changePasswordMessage, "Passwords do not match.", "error");
    return;
  }

  const activeEmail = state.activeUser.email.toLowerCase();
  const userRecord = state.users.find((user) => user.email.toLowerCase() === activeEmail);
  if (!userRecord) {
    setStatusMessage(elements.changePasswordMessage, "Could not find your account. Try signing in again.", "error");
    return;
  }

  userRecord.password = newPassword;
  saveUsers();
  setStatusMessage(elements.changePasswordMessage, "Password updated.", "success");
  elements.changePasswordForm.reset();
}


function handlePasswordResetAction(event) {
  const trigger = event.target.closest("[data-resolve-reset-request]");
  if (!trigger) {
    return;
  }

  const email = trigger.getAttribute("data-resolve-reset-request").toLowerCase();
  const inputId = trigger.getAttribute("data-reset-input");
  const input = document.getElementById(inputId);
  const newPassword = input?.value.trim() || "";

  if (newPassword.length < 6) {
    input?.focus();
    return;
  }

  const userRecord = state.users.find((user) => user.email.toLowerCase() === email);
  if (!userRecord) {
    return;
  }

  userRecord.password = newPassword;
  saveUsers();

  const request = state.passwordResetRequests.find(
    (item) => String(item.email || "").toLowerCase() === email && !item.resolvedAt
  );
  if (request) {
    request.resolvedAt = new Date().toISOString();
    request.resolvedByName = state.activeUser?.name || "Admin";
  }
  persistCollection("passwordResetRequests", state.passwordResetRequests);

  renderPasswordResetRequestsPanel();
}


function handlePantryAlertsToggle() {
  state.pantryAlertsExpanded = !state.pantryAlertsExpanded;
  renderPantryAlertsPanel();
}


function handleToggleAddUserForm() {
  const isHidden = elements.addUserForm.classList.toggle("hidden");
  elements.toggleAddUserForm.textContent = isHidden ? "+ Add user" : "✕ Close";
  elements.userStatsStrip.classList.toggle("hidden", !isHidden);
  elements.userDirectoryPanel.classList.toggle("hidden", !isHidden);
}


function handleAssignTask(event) {
  event.preventDefault();

  if (!canAssignTasks(state.activeUser)) {
    setStatusMessage(elements.assignTaskMessage, "Only admin users with EA designation can assign tasks.", "error");
    return;
  }

  const assignee = resolveTaskAssignee(elements.assignTaskUser.value);
  if (!assignee) {
    setStatusMessage(elements.assignTaskMessage, "Select a valid employee first.", "error");
    return;
  }

  const plannedDate = normalizePlannedDate(
    elements.assignTaskPlanned.value || DEFAULT_TASK_START_DATE
  );
  const frequency = normalizeFrequency(elements.assignTaskFrequency.value);
  const sequenceInput = elements.assignTaskSequence.value.trim();
  const task = normalizeTask({
    id: state.editingTaskId || elements.assignTaskId.value.trim(),
    taskId: elements.assignTaskId.value.trim(),
    title: elements.assignTaskTitle.value.trim(),
    frequency,
    sequence: sequenceInput ? Number(sequenceInput) : undefined,
    department: elements.assignTaskDepartment.value.trim(),
    plannedDate,
    validUntil: calculateValidUntil(plannedDate, frequency),
    details: elements.assignTaskDetails.value.trim(),
    createdAt: new Date().toISOString(),
    assigneeEmail: assignee.email,
    assigneeName: assignee.name,
    assigneeRole: assignee.role,
    assignedByEmail: state.activeUser.email,
    assignedByName: state.activeUser.name,
    active: true,
  });

  const isEditing = Boolean(state.editingTaskId);
  const requiredDefinition = getRequiredOperationalDefinition(task);
  if (requiredDefinition) {
    removeDeletedRequiredTaskId(requiredDefinition.taskId);
    saveDeletedRequiredTaskIds();
  }

  if (isEditing) {
    const taskIndex = state.tasks.findIndex((item) => String(item.id) === String(state.editingTaskId));
    if (taskIndex >= 0) {
      state.tasks[taskIndex] = {
        ...state.tasks[taskIndex],
        ...task,
      };
    } else {
      state.tasks.unshift(task);
    }
  } else {
    state.tasks.unshift(task);
  }

  saveTasks();
  closeAssignTaskModal();
  renderDashboard();
  setStatusMessage(
    elements.assignTaskMessage,
    isEditing
      ? `Task updated for ${assignee.name}. It repeats from ${formatDateValue(plannedDate)} through ${formatDateValue(task.validUntil)}.`
      : `Task assigned to ${assignee.name}. It repeats from ${formatDateValue(plannedDate)} through ${formatDateValue(task.validUntil)}.`,
    "success"
  );
}


async function handleChecklistSubmit(event) {
  event.preventDefault();

  if (!state.activeChecklistTask) {
    setStatusMessage(elements.checklistMessage, "No task is selected for checklist submission.", "error");
    return;
  }

  if (isPantryTask(state.activeChecklistTask)) {
    await handlePantryChecklistSubmit();
    return;
  }

  if (isGeneratorChecklistTask(state.activeChecklistTask)) {
    await handleGeneratorChecklistSubmit();
    return;
  }

  if (isCashHandlingChecklistTask(state.activeChecklistTask)) {
    await handleCashHandlingChecklistSubmit();
    return;
  }

  if (isMeterReadingChecklistTask(state.activeChecklistTask)) {
    await handleMeterReadingChecklistSubmit();
    return;
  }

  if (isEarthingCleaningTask(state.activeChecklistTask)) {
    await handleEarthingCleaningChecklistSubmit();
    return;
  }

  const template = getChecklistTemplate(state.activeChecklistTask);

  const unansweredCheckbox = template.questions.find(
    (question) => question.type === "checkbox" && !getCheckboxQuestionAnswer(question)
  );
  if (unansweredCheckbox) {
    setStatusMessage(elements.checklistMessage, `Select Yes or No for "${unansweredCheckbox.label}".`, "error");
    return;
  }

  const missingFollowUp = template.questions.find((question) => {
    if (question.type !== "checkbox" || !question.followUpOnNo) {
      return false;
    }
    if (getCheckboxQuestionAnswer(question) !== "No") {
      return false;
    }
    const followUpField = document.getElementById(`question-${question.id}-followup`);
    return !followUpField?.value.trim();
  });
  if (missingFollowUp) {
    setStatusMessage(elements.checklistMessage, `Answer "${missingFollowUp.followUpOnNo.label}".`, "error");
    return;
  }

  let responses;
  try {
    responses = await collectChecklistResponses(template);
  } catch (error) {
    setStatusMessage(elements.checklistMessage, error.message || "Could not upload the attachment.", "error");
    return;
  }

  const fuelValidation = validateFuelChecklistSubmission(state.activeChecklistTask, responses);
  if (!fuelValidation.ok) {
    setStatusMessage(elements.checklistMessage, fuelValidation.message, "error");
    return;
  }

  const completionKey = getCompletionKey(state.activeChecklistTask);
  const submittedAt = new Date().toISOString();
  const fuelRoute = getFuelApprovalRoute(state.activeChecklistTask, responses);

  state.completions[completionKey] = {
    taskId: state.activeChecklistTask.taskId || state.activeChecklistTask.id,
    occurrenceDate: state.activeChecklistTask.occurrenceDate,
    occurrenceSlot: state.activeChecklistTask.occurrenceSlot || null,
    occurrenceSlotLabel: state.activeChecklistTask.occurrenceSlotLabel || "",
    submittedAt,
    responses,
    approvalStatus: "pending",
    ...(requiresKamalPreApproval(state.activeChecklistTask) ? { kamalApprovalStatus: "pending" } : {}),
    ...(requiresArunPreApproval(state.activeChecklistTask) ? { arunApprovalStatus: "pending" } : {}),
    ...(fuelRoute ? { fuelMileage: fuelRoute.mileage, fuelMileageThreshold: fuelRoute.threshold } : {}),
    ...(fuelRoute?.route === "cashier" ? { cashierApprovalStatus: "pending" } : {}),
    ...(fuelRoute?.route === "hr" ? { hrApprovalStatus: "pending" } : {}),
  };

  saveCompletions();
  exportChecklistSubmissionToSheet(state.activeChecklistTask, responses, submittedAt);
  syncSubmissionReport();
  closeChecklistModal();
  renderEmployeeTaskBoard();
  renderApprovalsPage();
}


function exportChecklistSubmissionToSheet(task, responses, submittedAt) {
  if (normalizeTaskTitle(task?.title) !== "ac checklist") {
    return;
  }

  const payload = {
    taskId: task.taskId || task.id,
    taskTitle: task.title,
    assigneeName: task.assigneeName,
    occurrenceDate: task.occurrenceDate,
    occurrenceSlot: task.occurrenceSlot || null,
    occurrenceSlotLabel: task.occurrenceSlotLabel || "",
    submittedAt,
    responses,
  };
  const primaryUrl = buildApiUrl("/api/checklist-sheet-submission");
  const fallbackUrl = "/api/checklist-sheet-submission";
  const shouldTryFallback = primaryUrl !== fallbackUrl;

  const sendSubmission = (url) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Checklist sheet export failed with status ${response.status}.`);
      }
      return response.json();
    });

  sendSubmission(primaryUrl)
    .catch((error) => {
      if (!shouldTryFallback) {
        throw error;
      }
      console.warn(`Primary checklist sheet export failed for ${primaryUrl}; retrying ${fallbackUrl}.`, error);
      return sendSubmission(fallbackUrl);
    })
    .catch((error) => {
      console.error("Could not export checklist submission to Google Sheets.", error);
    });
}


// Rebuilds the whole Submissions Report sheet from scratch — every occurrence
// of every active task, submitted or not, so pending rows show up (Actual
// Date "-") and flip to a real date/score the moment they're submitted. This
// is a fire-and-forget side effect — it never blocks or surfaces errors in
// the checklist flow, since the report is a secondary record, not the source
// of truth (state.completions is).
// The server computes the audit rows itself (from the store's own tasks and
// completions — see lib/submission-audit.js) rather than trusting whatever
// this browser posts, so every sync reflects the currently-deployed logic
// no matter how stale this particular tab is.
function syncSubmissionReport() {
  waitForCompletionsPersistence()
    .catch(() => {
      // The persistence helper has already reported the save error. Still
      // attempt a sync so a later retry can export the server's latest state.
    })
    .then(() =>
      fetch(buildApiUrl("/api/submission-report-sync"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      })
    )
    .catch((error) => {
      console.error("Could not sync the submission report.", error);
    });
}


// Same rewrite as syncSubmissionReport, but user-triggered with visible
// feedback — for forcing a fresh copy on demand instead of waiting for the
// next checklist submission (the only thing that normally fires the rewrite).
async function handleResyncSubmissionReport() {
  setStatusMessage(elements.resyncSubmissionReportMessage, "Rewriting the sheet…", "");
  elements.resyncSubmissionReportButton.disabled = true;

  try {
    const response = await fetch(buildApiUrl("/api/submission-report-sync"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || "The server rejected the sync.");
    }
    setStatusMessage(
      elements.resyncSubmissionReportMessage,
      `Sheets updated — ${result.rowCount ?? "all"} audit rows and ${result.detailsRowCount ?? 0} detailed submission rows written.`,
      "success"
    );
  } catch (error) {
    setStatusMessage(elements.resyncSubmissionReportMessage, `Could not resync: ${error.message}`, "error");
  } finally {
    elements.resyncSubmissionReportButton.disabled = false;
  }
}


function handleVisitOpenClick(visitNumber) {
  const task = state.activeChecklistTask;
  if (!task) {
    return;
  }

  window.open(CONSTRUCTION_SITE_FORM_URL, "_blank", "noopener");

  // Opening the form is the operational confirmation for a site visit. Keep
  // that progress in MoTrack immediately; the linked form remains its detail record.
  const submittedAt = new Date().toISOString();
  state.completions[getVisitCompletionKey(task, visitNumber)] = {
    taskId: task.taskId || task.id,
    occurrenceDate: task.occurrenceDate,
    occurrenceSlot: task.occurrenceSlot || null,
    occurrenceSlotLabel: task.occurrenceSlotLabel || "",
    visitNumber,
    openedForm: true,
    submittedAt,
    responses: { visit_number: visitNumber },
  };

  const visits = {};
  for (let number = 1; number <= SITE_VISIT_COUNT; number++) {
    const completion = state.completions[getVisitCompletionKey(task, number)];
    visits[number] = completion ? completion.responses : null;
  }

  if (Object.values(visits).every(Boolean)) {
    state.completions[getCompletionKey(task)] = {
      taskId: task.taskId || task.id,
      occurrenceDate: task.occurrenceDate,
      occurrenceSlot: task.occurrenceSlot || null,
      occurrenceSlotLabel: task.occurrenceSlotLabel || "",
      submittedAt,
      responses: { visits },
      approvalStatus: "pending",
    };
  }

  saveCompletions();
  syncSubmissionReport();
  renderEmployeeTaskBoard();
  renderApprovalsPage();
  renderVisitPicker(task);
  setStatusMessage(elements.checklistMessage, `Visit ${visitNumber} marked submitted.`, "success");
}

async function refreshActiveSiteVisitProgress() {
  const task = state.activeChecklistTask;
  if (!task || !isSiteVisitTask(task)) {
    return;
  }

  // Allow a just-opened visit to finish saving before reloading server state.
  await waitForCompletionsPersistence();
  await refreshStateFromServer();
  renderEmployeeTaskBoard();
  renderApprovalsPage();

  if (!elements.checklistModal.classList.contains("hidden") && state.activeChecklistTask === task) {
    renderVisitPicker(task);
  }
}


async function handleGeneratorChecklistSubmit() {
  const task = state.activeChecklistTask;
  const generatorUnit = state.activeGeneratorUnit;

  if (!generatorUnit) {
    setStatusMessage(elements.checklistMessage, "Select a generator first.", "error");
    return;
  }

  const template = buildGeneratorChecklistTemplate(generatorUnit);
  let responses;
  try {
    responses = await collectChecklistResponses(template);
  } catch (error) {
    setStatusMessage(elements.checklistMessage, error.message || "Could not upload the attachment.", "error");
    return;
  }
  const submittedAt = new Date().toISOString();

  state.completions[getGeneratorCompletionKey(task, generatorUnit)] = {
    taskId: task.taskId || task.id,
    occurrenceDate: task.occurrenceDate,
    occurrenceSlot: task.occurrenceSlot || null,
    occurrenceSlotLabel: task.occurrenceSlotLabel || "",
    generatorUnit,
    submittedAt,
    responses: {
      ...responses,
      generator_unit: generatorUnit,
    },
  };

  const generators = {};
  GENERATOR_CHECKLIST_UNITS.forEach((unit) => {
    const completion = state.completions[getGeneratorCompletionKey(task, unit)];
    generators[unit] = completion ? completion.responses : null;
  });

  const allGeneratorsDone = GENERATOR_CHECKLIST_UNITS.every((unit) =>
    Boolean(state.completions[getGeneratorCompletionKey(task, unit)])
  );

  if (allGeneratorsDone) {
    state.completions[getCompletionKey(task)] = {
      taskId: task.taskId || task.id,
      occurrenceDate: task.occurrenceDate,
      occurrenceSlot: task.occurrenceSlot || null,
      occurrenceSlotLabel: task.occurrenceSlotLabel || "",
      submittedAt,
      responses: { generators },
      approvalStatus: "pending",
    };
  }

  saveCompletions();
  syncSubmissionReport();
  renderEmployeeTaskBoard();
  renderApprovalsPage();

  if (allGeneratorsDone) {
    closeChecklistModal();
    return;
  }

  renderGeneratorPicker(task);
  setStatusMessage(
    elements.checklistMessage,
    `${generatorUnit} checklist saved. Select the next generator.`,
    "success"
  );
}


async function handleCashHandlingChecklistSubmit() {
  const task = state.activeChecklistTask;
  const shift = state.activeCashHandlingShift;

  if (!shift) {
    setStatusMessage(elements.checklistMessage, "Select a shift first.", "error");
    return;
  }

  const template = buildCashHandlingChecklistTemplate(shift);
  let responses;
  try {
    responses = await collectChecklistResponses(template);
  } catch (error) {
    setStatusMessage(elements.checklistMessage, error.message || "Could not upload the attachment.", "error");
    return;
  }
  const denominations = collectCashDenominationRows();
  const coins = collectCashCoinRows();
  const coinsAmount = coins.reduce((sum, row) => sum + row.amount, 0);
  const totalAmount = denominations.reduce((sum, row) => sum + row.amount, 0) + coinsAmount;
  const submittedAt = new Date().toISOString();

  state.completions[getCashHandlingCompletionKey(task, shift)] = {
    taskId: task.taskId || task.id,
    occurrenceDate: task.occurrenceDate,
    occurrenceSlot: task.occurrenceSlot || null,
    occurrenceSlotLabel: task.occurrenceSlotLabel || "",
    shift,
    submittedAt,
    responses: {
      ...responses,
      shift,
      denominations,
      coins,
      coins_amount: coinsAmount,
      total_cash_amount: totalAmount,
    },
  };

  const shifts = {};
  CASH_HANDLING_SHIFTS.forEach((shiftName) => {
    const completion = state.completions[getCashHandlingCompletionKey(task, shiftName)];
    shifts[shiftName] = completion ? completion.responses : null;
  });

  const allShiftsDone = CASH_HANDLING_SHIFTS.every((shiftName) =>
    Boolean(state.completions[getCashHandlingCompletionKey(task, shiftName)])
  );

  if (allShiftsDone) {
    state.completions[getCompletionKey(task)] = {
      taskId: task.taskId || task.id,
      occurrenceDate: task.occurrenceDate,
      occurrenceSlot: task.occurrenceSlot || null,
      occurrenceSlotLabel: task.occurrenceSlotLabel || "",
      submittedAt,
      responses: { shifts },
      approvalStatus: "pending",
    };
  }

  saveCompletions();
  syncSubmissionReport();
  renderEmployeeTaskBoard();
  renderApprovalsPage();

  if (allShiftsDone) {
    closeChecklistModal();
    return;
  }

  renderCashHandlingPicker(task);
  setStatusMessage(
    elements.checklistMessage,
    `${shift} checklist saved. Select the next shift.`,
    "success"
  );
}


async function handleMeterReadingChecklistSubmit() {
  const task = state.activeChecklistTask;
  const location = state.activeMeterReadingLocation;

  if (!location) {
    setStatusMessage(elements.checklistMessage, "Select a location first.", "error");
    return;
  }

  const template = buildMeterReadingChecklistTemplate(location);
  let responses;
  try {
    responses = await collectChecklistResponses(template);
  } catch (error) {
    setStatusMessage(elements.checklistMessage, error.message || "Could not upload the attachment.", "error");
    return;
  }
  const submittedAt = new Date().toISOString();

  state.completions[getMeterReadingCompletionKey(task, location)] = {
    taskId: task.taskId || task.id,
    occurrenceDate: task.occurrenceDate,
    occurrenceSlot: task.occurrenceSlot || null,
    occurrenceSlotLabel: task.occurrenceSlotLabel || "",
    location,
    submittedAt,
    responses: {
      ...responses,
      location,
    },
  };

  const locations = {};
  METER_READING_LOCATIONS.forEach((locationName) => {
    const completion = state.completions[getMeterReadingCompletionKey(task, locationName)];
    locations[locationName] = completion ? completion.responses : null;
  });

  const allLocationsDone = METER_READING_LOCATIONS.every((locationName) =>
    Boolean(state.completions[getMeterReadingCompletionKey(task, locationName)])
  );

  if (allLocationsDone) {
    state.completions[getCompletionKey(task)] = {
      taskId: task.taskId || task.id,
      occurrenceDate: task.occurrenceDate,
      occurrenceSlot: task.occurrenceSlot || null,
      occurrenceSlotLabel: task.occurrenceSlotLabel || "",
      submittedAt,
      responses: { locations },
      approvalStatus: "pending",
    };
  }

  saveCompletions();
  syncSubmissionReport();
  renderEmployeeTaskBoard();
  renderApprovalsPage();

  if (allLocationsDone) {
    closeChecklistModal();
    return;
  }

  renderMeterReadingPicker(task);
  setStatusMessage(
    elements.checklistMessage,
    `${location} checklist saved. Select the next location.`,
    "success"
  );
}


async function handleEarthingCleaningChecklistSubmit() {
  const task = state.activeChecklistTask;
  const location = state.activeEarthingCleaningLocation;

  if (!location) {
    setStatusMessage(elements.checklistMessage, "Select a location first.", "error");
    return;
  }

  const template = buildEarthingCleaningChecklistTemplate(location);
  let responses;
  try {
    responses = await collectChecklistResponses(template);
  } catch (error) {
    setStatusMessage(elements.checklistMessage, error.message || "Could not upload the attachment.", "error");
    return;
  }
  const submittedAt = new Date().toISOString();

  state.completions[getEarthingCleaningCompletionKey(task, location)] = {
    taskId: task.taskId || task.id,
    occurrenceDate: task.occurrenceDate,
    occurrenceSlot: task.occurrenceSlot || null,
    occurrenceSlotLabel: task.occurrenceSlotLabel || "",
    location,
    submittedAt,
    responses: {
      ...responses,
      location,
    },
  };

  const locations = {};
  EARTHING_CLEANING_LOCATIONS.forEach((locationName) => {
    const completion = state.completions[getEarthingCleaningCompletionKey(task, locationName)];
    locations[locationName] = completion ? completion.responses : null;
  });

  const allLocationsDone = EARTHING_CLEANING_LOCATIONS.every((locationName) =>
    Boolean(state.completions[getEarthingCleaningCompletionKey(task, locationName)])
  );

  if (allLocationsDone) {
    state.completions[getCompletionKey(task)] = {
      taskId: task.taskId || task.id,
      occurrenceDate: task.occurrenceDate,
      occurrenceSlot: task.occurrenceSlot || null,
      occurrenceSlotLabel: task.occurrenceSlotLabel || "",
      submittedAt,
      responses: { locations },
      approvalStatus: "pending",
    };
  }

  saveCompletions();
  syncSubmissionReport();
  renderEmployeeTaskBoard();
  renderApprovalsPage();

  if (allLocationsDone) {
    closeChecklistModal();
    return;
  }

  renderEarthingCleaningPicker(task);
  setStatusMessage(
    elements.checklistMessage,
    `${location} checklist saved. Select the next location.`,
    "success"
  );
}


function handlePantryChecklistSubmit() {
  if (!state.pantryFormLocation) {
    setStatusMessage(elements.checklistMessage, "Select MO1 or MO2 before submitting the checklist.", "error");
    return;
  }

  const quantityInputs = [...elements.checklistFields.querySelectorAll(".pantry-input--quantity")];
  if (!quantityInputs.length || quantityInputs.some((input) => input.value.trim() === "")) {
    setStatusMessage(elements.checklistMessage, "Enter the counted quantity for every item.", "error");
    return;
  }

  const task = state.activeChecklistTask;
  const location = state.pantryFormLocation;
  const submittedAt = new Date().toISOString();

  const items = quantityInputs.map((quantityInput) => {
    return {
      item: quantityInput.getAttribute("data-pantry-item"),
      expectedQuantity: Number(quantityInput.getAttribute("data-pantry-expected")),
      submittedQuantity: Number(quantityInput.value),
    };
  });

  const mismatches = items.filter((row) => row.submittedQuantity !== row.expectedQuantity);
  const completionKey = getCompletionKey(task);

  state.completions[completionKey] = {
    taskId: task.taskId || task.id,
    occurrenceDate: task.occurrenceDate,
    occurrenceSlot: task.occurrenceSlot || null,
    occurrenceSlotLabel: task.occurrenceSlotLabel || "",
    submittedAt,
    location,
    responses: { items },
    approvalStatus: "pending",
  };
  saveCompletions();
  syncSubmissionReport();

  if (mismatches.length) {
    mismatches.forEach((row) => {
      state.pantryAlerts.unshift({
        id: `${completionKey}__${normalizePersonName(row.item)}__${Date.now()}`,
        taskId: task.taskId || task.id,
        occurrenceDate: task.occurrenceDate,
        location,
        employeeName: task.assigneeName,
        item: row.item,
        submittedQuantity: row.submittedQuantity,
        expectedQuantity: row.expectedQuantity,
        submittedAt,
      });
    });
    savePantryAlerts();
  }

  closeChecklistModal();
  renderEmployeeTaskBoard();
  renderPantryAlertsPanel();
  renderApprovalsPage();
}


function handleChecklistFieldsClick(event) {
  const locationTrigger = event.target.closest("[data-pantry-location]");
  if (locationTrigger) {
    renderPantryChecklistTable(locationTrigger.getAttribute("data-pantry-location"));
    return;
  }

  const resetTrigger = event.target.closest("[data-pantry-location-reset]");
  if (resetTrigger) {
    state.pantryFormLocation = null;
    renderPantryLocationPicker();
    return;
  }

  const visitOpenTrigger = event.target.closest("[data-visit-open]");
  if (visitOpenTrigger) {
    handleVisitOpenClick(Number(visitOpenTrigger.getAttribute("data-visit-open")));
    return;
  }

  const generatorOpenTrigger = event.target.closest("[data-generator-open]");
  if (generatorOpenTrigger) {
    renderGeneratorChecklist(state.activeChecklistTask, generatorOpenTrigger.getAttribute("data-generator-open"));
    return;
  }

  const generatorResetTrigger = event.target.closest("[data-generator-reset]");
  if (generatorResetTrigger) {
    renderGeneratorPicker(state.activeChecklistTask);
    return;
  }

  const cashShiftOpenTrigger = event.target.closest("[data-cash-shift-open]");
  if (cashShiftOpenTrigger) {
    renderCashHandlingChecklist(state.activeChecklistTask, cashShiftOpenTrigger.getAttribute("data-cash-shift-open"));
    return;
  }

  const cashShiftResetTrigger = event.target.closest("[data-cash-shift-reset]");
  if (cashShiftResetTrigger) {
    renderCashHandlingPicker(state.activeChecklistTask);
    return;
  }

  const meterLocationOpenTrigger = event.target.closest("[data-meter-location-open]");
  if (meterLocationOpenTrigger) {
    renderMeterReadingChecklist(state.activeChecklistTask, meterLocationOpenTrigger.getAttribute("data-meter-location-open"));
    return;
  }

  const meterLocationResetTrigger = event.target.closest("[data-meter-location-reset]");
  if (meterLocationResetTrigger) {
    renderMeterReadingPicker(state.activeChecklistTask);
    return;
  }

  const earthingLocationOpenTrigger = event.target.closest("[data-earthing-location-open]");
  if (earthingLocationOpenTrigger) {
    renderEarthingCleaningChecklist(state.activeChecklistTask, earthingLocationOpenTrigger.getAttribute("data-earthing-location-open"));
    return;
  }

  const earthingLocationResetTrigger = event.target.closest("[data-earthing-location-reset]");
  if (earthingLocationResetTrigger) {
    renderEarthingCleaningPicker(state.activeChecklistTask);
    return;
  }

  const shareTrigger = event.target.closest("[data-share-duration]");
  if (shareTrigger) {
    startLiveLocationShare(Number(shareTrigger.getAttribute("data-share-duration")));
    return;
  }

  const stopShareTrigger = event.target.closest("[data-stop-sharing]");
  if (stopShareTrigger) {
    stopLiveLocationShare();
  }
}


function startLiveLocationShare(durationMinutes) {
  if (!navigator.geolocation) {
    setStatusMessage(elements.checklistMessage, "Location sharing isn't supported in this browser.", "error");
    return;
  }

  const task = state.activeChecklistTask;
  state.myLocationTask = task ? { taskId: task.taskId || task.id, title: task.title } : null;
  state.myLocationExpiresAt = Date.now() + durationMinutes * 60 * 1000;

  state.myLocationWatchId = navigator.geolocation.watchPosition(handleGeolocationUpdate, handleGeolocationError, {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 20000,
  });

  if (state.myLocationExpiryTimer) {
    clearInterval(state.myLocationExpiryTimer);
  }
  state.myLocationExpiryTimer = setInterval(checkMyLocationExpiry, 15000);

  renderLiveShareBanner();
  refreshLocationControlInPlace();
}


function handleGeolocationUpdate(position) {
  const now = Date.now();
  const alreadySharing = Boolean(state.liveLocations[state.activeUser.email]);
  if (alreadySharing && now - state.myLocationLastPushAt < 8000) {
    return;
  }
  state.myLocationLastPushAt = now;

  state.liveLocations[state.activeUser.email] = {
    employeeEmail: state.activeUser.email,
    employeeName: state.activeUser.name,
    taskId: state.myLocationTask?.taskId || null,
    taskTitle: state.myLocationTask?.title || null,
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    updatedAt: new Date().toISOString(),
    expiresAt: state.myLocationExpiresAt,
  };
  saveLiveLocations();
  renderApprovalsLivePage(state.currentView === "approvals" && state.approvalsTab === "live");

  if (state.checklistMapInstance) {
    refreshChecklistMapPosition();
  } else if (document.getElementById("visitLocationControl")) {
    initChecklistLocationMap();
  }
}


function handleGeolocationError(error) {
  setStatusMessage(
    elements.checklistMessage,
    `Could not get your location: ${error.message || "permission denied."}`,
    "error"
  );
  stopLiveLocationShare();
}


function checkMyLocationExpiry() {
  if (state.myLocationExpiresAt && Date.now() >= state.myLocationExpiresAt) {
    stopLiveLocationShare();
  } else {
    renderLiveShareBanner();
  }
}


function stopLiveLocationShare() {
  if (state.myLocationWatchId !== null) {
    navigator.geolocation.clearWatch(state.myLocationWatchId);
    state.myLocationWatchId = null;
  }
  if (state.myLocationExpiryTimer) {
    clearInterval(state.myLocationExpiryTimer);
    state.myLocationExpiryTimer = null;
  }
  state.myLocationExpiresAt = null;
  state.myLocationTask = null;

  if (state.activeUser && state.liveLocations[state.activeUser.email]) {
    delete state.liveLocations[state.activeUser.email];
    saveLiveLocations();
  }

  renderLiveShareBanner();
  refreshLocationControlInPlace();
}


function handleLiveShareBannerClick(event) {
  if (event.target.closest("[data-stop-sharing]")) {
    stopLiveLocationShare();
  }
}


function handleAbsenceSubmit(event) {
  event.preventDefault();

  if (!canManageUsers(state.activeUser)) {
    setStatusMessage(elements.absenceMessage, "Only admins can mark absences.", "error");
    return;
  }

  const employeeName = elements.absenceEmployeeInput.value.trim();
  const record = findBuddyRecordByEmployee(employeeName);
  if (!record) {
    setStatusMessage(elements.absenceMessage, "Select an employee from the buddy list first.", "error");
    return;
  }

  const absenceDate = normalizePlannedDate(elements.absenceDateInput.value || todayValue());
  const reason = elements.absenceReasonSelect.value || "Absent";
  const key = getAbsenceKey(record.employee, absenceDate);

  state.absences[key] = {
    employee: record.employee,
    date: absenceDate,
    reason,
  };

  saveAbsences();
  renderDashboard();
  setStatusMessage(
    elements.absenceMessage,
    `${record.employee} is marked ${reason.toLowerCase()} on ${formatDateValue(absenceDate)}. Buddy coverage is active.`,
    "success"
  );
}


function handleCoverageAction(event) {
  const trigger = event.target.closest("[data-clear-absence]");
  if (!trigger) {
    return;
  }

  if (!canManageUsers(state.activeUser)) {
    return;
  }

  const employee = trigger.getAttribute("data-employee");
  const dateValue = trigger.getAttribute("data-date");
  delete state.absences[getAbsenceKey(employee, dateValue)];
  saveAbsences();
  renderDashboard();
}


function handleAdminTaskAction(event) {
  const deleteTrigger = event.target.closest("[data-delete-task]");
  if (deleteTrigger) {
    handleDeleteTask(deleteTrigger.getAttribute("data-delete-task"));
    return;
  }

  const editTrigger = event.target.closest("[data-edit-task]");
  if (!editTrigger) {
    return;
  }

  const taskId = editTrigger.getAttribute("data-edit-task");
  const task = state.tasks.find((item) => String(item.id) === String(taskId));
  if (!task) {
    return;
  }

  openAssignTaskModal(task);
}


function handleDeleteTask(taskId) {
  if (!canAssignTasks(state.activeUser)) {
    window.alert("Only admin users with EA designation can delete tasks.");
    return;
  }

  const task = state.tasks.find((item) => String(item.id) === String(taskId));
  if (!task) {
    return;
  }

  const confirmed = window.confirm(`Delete "${task.title}" for ${task.assigneeName}? This cannot be undone.`);
  if (!confirmed) {
    return;
  }

  const requiredDefinition = getRequiredOperationalDefinition(task);
  if (requiredDefinition) {
    state.deletedRequiredTaskIds = getDeletedRequiredTaskIds([
      ...state.deletedRequiredTaskIds,
      requiredDefinition.taskId || task.taskId || task.id,
    ]);
    saveDeletedRequiredTaskIds();

    state.tasks = state.tasks.map((item) =>
      String(item.id) === String(taskId)
        ? {
            ...item,
            active: false,
          }
        : item
    );
    saveTasks();
    renderDashboard();
    return;
  }

  state.tasks = state.tasks.filter((item) => String(item.id) !== String(taskId));
  saveTasks();
  renderDashboard();
}


function handleDirectorySearch(event) {
  state.query = event.target.value.trim().toLowerCase();
  state.userTablePage = 1;
  renderUserDirectory();
}


function handleContactsSearch(event) {
  state.contactsQuery = event.target.value.trim().toLowerCase();
  state.contactsPage = 1;
  renderContactDirectory();
}


function handleRoleFilterChange(event) {
  state.role = event.target.value;
  state.userTablePage = 1;
  renderUserDirectory();
}


function handleDayOffFilterChange(event) {
  state.dayOff = event.target.value;
  state.userTablePage = 1;
  renderUserDirectory();
}


function handleEmployeeTaskFilterChange() {
  state.employeeTaskPage = 1;
  renderEmployeeTaskBoard();
}


function handlePcMonitorDateChange() {
  state.pcMonitorDate = elements.pcMonitorDateInput.value || todayValue();
  state.pcSubmittedPage = 1;
  renderPcDashboardPanel();
}


function handleApprovalsDateChange() {
  state.approvalsPendingPage = 1;
  state.approvalsCompletedPage = 1;
  state.approvalsNotCompletedPage = 1;
  state.approvalsApprovedPage = 1;
  renderApprovalsPage();
}


function handleComplianceDateChange() {
  renderCompliancePage();
}


function handleApprovalsTabClick(event) {
  const trigger = event.target.closest("[data-approvals-tab]");
  if (!trigger) {
    return;
  }

  state.approvalsTab = trigger.getAttribute("data-approvals-tab");
  renderApprovalsPage();
  syncLiveMapRefreshTimer();
}


const LIVE_MAP_REFRESH_MS = 10 * 1000;

function syncLiveMapRefreshTimer() {
  const shouldPoll = state.currentView === "approvals" && state.approvalsTab === "live";

  if (shouldPoll && !state.liveMapRefreshTimer) {
    state.liveMapRefreshTimer = setInterval(() => {
      refreshStateFromServer().then(renderApprovalsPage);
    }, LIVE_MAP_REFRESH_MS);
  } else if (!shouldPoll && state.liveMapRefreshTimer) {
    clearInterval(state.liveMapRefreshTimer);
    state.liveMapRefreshTimer = null;
  }
}


function handleApprovalsAction(event) {
  if (!canAssignTasks(state.activeUser)) {
    return;
  }

  const trigger = event.target.closest("[data-approve-completion]");
  if (!trigger) {
    return;
  }

  const completionKey = trigger.getAttribute("data-approve-completion");
  const completion = state.completions[completionKey];
  if (!completion) {
    return;
  }

  completion.approvalStatus = "approved";
  completion.approvedByName = state.activeUser.name;
  completion.approvedAt = new Date().toISOString();

  saveCompletions();
  renderApprovalsPage();
}


function handleSubmissionDetailsAction(event) {
  const trigger = event.target.closest("[data-open-submission-details]");
  if (!trigger) {
    return;
  }

  openSubmissionDetailsModal(trigger.getAttribute("data-open-submission-details"));
}


function handleKamalApprovalAction(event) {
  const trigger = event.target.closest("[data-kamal-approve-completion]");
  if (!trigger) {
    return;
  }

  const completionKey = trigger.getAttribute("data-kamal-approve-completion");
  const completion = state.completions[completionKey];
  if (!completion) {
    return;
  }

  if (completion.hrApprovalStatus === "pending") {
    completion.hrApprovalStatus = "approved";
  } else {
    completion.kamalApprovalStatus = "approved";
  }
  completion.kamalApprovedByName = state.activeUser.name;
  completion.kamalApprovedAt = new Date().toISOString();

  saveCompletions();
  renderKamalApprovalPanel();
  renderApprovalsPage();
}


function handleFuelRequestApprovalAction(event) {
  const trigger = event.target.closest("[data-fuel-approve-completion]");
  if (!trigger) {
    return;
  }

  const completionKey = trigger.getAttribute("data-fuel-approve-completion");
  const completion = state.completions[completionKey];
  if (!completion) {
    return;
  }

  completion.fuelRequestApprovalStatus = "approved";
  completion.fuelRequestApprovedByName = state.activeUser.name;
  completion.fuelRequestApprovedAt = new Date().toISOString();

  saveCompletions();
  renderFuelApprovalPanel();
  renderApprovalsPage();
}


function handleArunApprovalAction(event) {
  const trigger = event.target.closest("[data-arun-approve-completion]");
  if (!trigger) {
    return;
  }

  const completionKey = trigger.getAttribute("data-arun-approve-completion");
  const completion = state.completions[completionKey];
  if (!completion) {
    return;
  }

  completion.arunApprovalStatus = "approved";
  completion.arunApprovedByName = state.activeUser.name;
  completion.arunApprovedAt = new Date().toISOString();

  saveCompletions();
  renderArunApprovalPanel();
  renderApprovalsPage();
}


function handleHomeSearch(event) {
  state.homeSearch = event.target.value.trim().toLowerCase();
  state.adminBoardPage = 1;
  renderAdminTaskBoard();
}


function handleAdminDateChange(event) {
  state.adminDate = event.target.value;
  state.adminBoardPage = 1;
  renderAdminTaskBoard();
}


function handleAssignModalBackdropClick(event) {
  if (event.target === elements.assignTaskModal) {
    closeAssignTaskModal();
  }
}


function handleChecklistModalBackdropClick(event) {
  if (event.target === elements.checklistModal) {
    closeChecklistModal();
  }
}


function handleNotCompletedModalBackdropClick(event) {
  if (event.target === elements.notCompletedModal) {
    closeNotCompletedModal();
  }
}


async function handleSubmissionDetailsModalBackdropClick(event) {
  const attachmentTrigger = event.target.closest("[data-open-submission-attachment]");
  if (attachmentTrigger) {
    await openSavedChecklistAttachment(attachmentTrigger.getAttribute("data-open-submission-attachment"));
    return;
  }
  if (event.target === elements.submissionDetailsModal) {
    closeSubmissionDetailsModal();
  }
}


async function openSavedChecklistAttachment(pathname) {
  if (!pathname) {
    return;
  }

  const viewer = window.open("", "_blank");
  if (!viewer) {
    setStatusMessage(elements.checklistMessage, "Allow pop-ups to view the attachment.", "error");
    return;
  }
  viewer.document.title = "Loading attachment";

  try {
    const response = await fetch(`${buildApiUrl("/api/checklist-attachment")}?pathname=${encodeURIComponent(pathname)}`, {
      headers: authHeaders(),
    });
    if (!response.ok) {
      throw new Error("The attachment could not be opened.");
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    viewer.location.replace(objectUrl);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 1000);
  } catch (error) {
    viewer.close();
    setStatusMessage(elements.checklistMessage, error.message || "The attachment could not be opened.", "error");
  }
}


function handleEmployeeTaskAction(event) {
  const requestTrigger = event.target.closest("[data-request-fuel-task]");
  if (requestTrigger) {
    handleFuelRequestSubmit(requestTrigger);
    return;
  }

  const trigger = event.target.closest("[data-complete-task]");
  if (!trigger) {
    return;
  }

  const taskKey = trigger.getAttribute("data-task-key");
  const task =
    state.visibleEmployeeTasks.find((item) => getTaskOccurrenceIdentity(item) === taskKey) ||
    state.visibleWalkinTasks.find((item) => getTaskOccurrenceIdentity(item) === taskKey);

  if (!task || !isTaskCompletionEnabled(task)) {
    return;
  }

  openChecklistModal(task);
}

// No modal, no data entry — requesting fuel is itself the whole submission.
// Either approver (Dilip or Ashish Yadav) can then approve it from their
// own dashboard, at which point it shows as completed like any other task.
function handleFuelRequestSubmit(trigger) {
  const taskKey = trigger.getAttribute("data-task-key");
  const task =
    state.visibleEmployeeTasks.find((item) => getTaskOccurrenceIdentity(item) === taskKey) ||
    state.visibleWalkinTasks.find((item) => getTaskOccurrenceIdentity(item) === taskKey);

  if (!task || !isTaskCompletionEnabled(task)) {
    return;
  }

  const completionKey = getCompletionKey(task);
  state.completions[completionKey] = {
    taskId: task.taskId || task.id,
    occurrenceDate: task.occurrenceDate || task.plannedDate,
    submittedAt: new Date().toISOString(),
    responses: {},
    approvalStatus: "pending",
    fuelRequestApprovalStatus: "pending",
    submittedByName: state.activeUser.name,
    submittedByEmail: state.activeUser.email,
  };

  saveCompletions();
  syncSubmissionReport();
  renderEmployeeTaskBoard();
  renderApprovalsPage();
}


function handleEmployeeStatusSelectChange(event) {
  const select = event.target.closest("[data-status-select]");
  if (!select) {
    return;
  }

  const taskKey = select.getAttribute("data-task-key");
  const task =
    state.visibleEmployeeTasks.find((item) => getTaskOccurrenceIdentity(item) === taskKey) ||
    state.visibleWalkinTasks.find((item) => getTaskOccurrenceIdentity(item) === taskKey);

  const value = select.value;
  // Reset immediately rather than waiting on a re-render — completed opens a
  // modal that may be cancelled, and not_completed's own modal can likewise
  // be cancelled, in which case there'd be no re-render to put this back to
  // the placeholder otherwise.
  select.value = "";

  if (!task || !isTaskCompletionEnabled(task)) {
    return;
  }

  if (value === "completed") {
    if (isClientFormTask(task)) {
      openClientFormForTask(task);
    }
    openChecklistModal(task);
  } else if (value === "not_completed") {
    openNotCompletedModal(task);
  }
}

// Opens the real client intake form in a new tab (for the showroom TV) when
// a salesman marks the "Take input of customer requirement" task complete.
// Purely additive — the normal completion modal above still runs as usual.
function openClientFormForTask(task) {
  const params = new URLSearchParams({
    walkinId: task.customerAttributionKey || task.walkinId || "",
    customerName: task.customerAttributionName || task.customerName || "",
    submittedByName: state.activeUser?.name || "",
    submittedByEmail: state.activeUser?.email || "",
  });
  window.open(`/client-form.html?${params.toString()}`, "_blank");
}


async function logout() {
  stopLiveLocationShare();

  const token = getAuthToken();
  if (token) {
    try {
      await fetch(buildApiUrl("/api/logout"), { method: "POST", headers: authHeaders() });
    } catch (error) {
      console.error("Could not reach the server to invalidate the session token.", error);
    }
  }

  state.activeUser = null;
  state.currentView = "home";
  state.isSidebarCollapsed = false;
  state.pcMonitorDate = todayValue();
  state.activeChecklistTask = null;
  localStorage.removeItem(STORAGE_KEYS.session);
  clearAuthToken();
  closeAssignTaskModal();
  closeChecklistModal();
  toggleViews(false);
  elements.passwordInput.value = "";
  setStatusMessage(elements.loginMessage, "You have been logged out.", "success");
}


function refreshUserViews() {
  populateFilters();
  populateTaskAssigneeOptions();
  renderDashboard();
}


function syncTaskAssignmentFields() {
  const selectedUser = resolveTaskAssignee(elements.assignTaskUser.value);
  if (!selectedUser) {
    elements.assignTaskDepartment.value = "";
    elements.assignTaskId.value = "";
    return;
  }

  elements.assignTaskDepartment.value = getDepartmentLabel(selectedUser);
  elements.assignTaskPlanned.value = normalizePlannedDate(
    elements.assignTaskPlanned.value || DEFAULT_TASK_START_DATE
  );
  elements.assignTaskId.value = elements.assignTaskId.value || createTaskCode(selectedUser);
  elements.assignTaskUser.value = formatTaskAssigneeOption(selectedUser);
}


function openAssignTaskModal(taskToEdit = null) {
  if (!canAssignTasks(state.activeUser)) {
    return;
  }

  elements.assignTaskForm.reset();
  elements.assignTaskMessage.textContent = "";
  populateTaskAssigneeOptions();

  if (taskToEdit) {
    state.editingTaskId = taskToEdit.id;
    const assignee = state.users.find((user) => user.email.toLowerCase() === taskToEdit.assigneeEmail.toLowerCase());
    elements.assignTaskModalTitle.textContent = "Edit employee task";
    elements.assignTaskSubmitButton.textContent = "Save changes";
    elements.assignTaskUser.value = assignee ? formatTaskAssigneeOption(assignee) : taskToEdit.assigneeName;
    elements.assignTaskTitle.value = taskToEdit.title;
    elements.assignTaskFrequency.value = getTaskDisplayFrequency(taskToEdit);
    elements.assignTaskDepartment.value = taskToEdit.department;
    elements.assignTaskPlanned.value = normalizePlannedDate(taskToEdit.plannedDate || todayValue());
    elements.assignTaskId.value = taskToEdit.taskId || taskToEdit.id;
    elements.assignTaskSequence.value = Number.isFinite(taskToEdit.sequence) ? taskToEdit.sequence : "";
    elements.assignTaskDetails.value = taskToEdit.details || "";
  } else {
    state.editingTaskId = null;
    elements.assignTaskModalTitle.textContent = "Create task for employee dashboard";
    elements.assignTaskSubmitButton.textContent = "Submit task";
    elements.assignTaskFrequency.value = "daily";
    elements.assignTaskPlanned.value = DEFAULT_TASK_START_DATE;
    elements.assignTaskId.value = "";
    syncTaskAssignmentFields();
  }

  elements.assignTaskModal.classList.remove("hidden");
  elements.assignTaskModal.setAttribute("aria-hidden", "false");
}


function closeAssignTaskModal() {
  state.editingTaskId = null;
  elements.assignTaskModalTitle.textContent = "Create task for employee dashboard";
  elements.assignTaskSubmitButton.textContent = "Submit task";
  elements.assignTaskModal.classList.add("hidden");
  elements.assignTaskModal.setAttribute("aria-hidden", "true");
}


function openChecklistModal(task) {
  state.activeChecklistTask = task;
  state.activeGeneratorUnit = null;
  state.activeCashHandlingShift = null;
  state.activeMeterReadingLocation = null;
  state.activeEarthingCleaningLocation = null;
  state.pantryFormLocation = null;
  elements.checklistForm.reset();
  elements.checklistMessage.textContent = "";
  elements.checklistSubmitRow.classList.remove("hidden");
  const slotLabel = task.occurrenceSlotLabel ? ` | ${task.occurrenceSlotLabel}` : "";
  elements.checklistTaskMeta.textContent = `${task.assigneeName} | ${formatDateValue(task.occurrenceDate)}${slotLabel} | Task ID ${task.taskId || task.id}`;

  if (isPantryTask(task)) {
    elements.checklistTaskTitle.textContent = "PANTRY CHECKLIST";
    renderPantryLocationPicker();
  } else if (isSiteVisitTask(task)) {
    elements.checklistTaskTitle.textContent = SITE_VISIT_TITLE;
    renderVisitPicker(task);
  } else if (isGeneratorChecklistTask(task)) {
    const template = getChecklistTemplate(task);
    elements.checklistTaskTitle.textContent = template.title;
    renderGeneratorPicker(task);
  } else if (isCashHandlingChecklistTask(task)) {
    const template = getChecklistTemplate(task);
    elements.checklistTaskTitle.textContent = template.title;
    renderCashHandlingPicker(task);
  } else if (isMeterReadingChecklistTask(task)) {
    const template = getChecklistTemplate(task);
    elements.checklistTaskTitle.textContent = template.title;
    renderMeterReadingPicker(task);
  } else if (isEarthingCleaningTask(task)) {
    const template = getChecklistTemplate(task);
    elements.checklistTaskTitle.textContent = template.title;
    renderEarthingCleaningPicker(task);
  } else {
    const template = getChecklistTemplate(task);
    elements.checklistTaskTitle.textContent = template.title;
    renderChecklistFields(template);
  }

  elements.checklistModal.classList.remove("hidden");
  elements.checklistModal.setAttribute("aria-hidden", "false");
  autoFillVehicleFieldsFromLoginEmail(task);
}


function closeChecklistModal() {
  destroyChecklistMap();
  state.activeChecklistTask = null;
  state.activeGeneratorUnit = null;
  state.activeCashHandlingShift = null;
  state.activeMeterReadingLocation = null;
  state.activeEarthingCleaningLocation = null;
  state.pantryFormLocation = null;
  elements.checklistModal.classList.add("hidden");
  elements.checklistModal.setAttribute("aria-hidden", "true");
}


function openNotCompletedModal(task) {
  state.activeNotCompletedTask = task;
  elements.notCompletedForm.reset();
  elements.notCompletedMessage.textContent = "";
  elements.notCompletedTaskTitle.textContent = getTaskDisplayTitle(task);
  elements.notCompletedModal.classList.remove("hidden");
  elements.notCompletedModal.setAttribute("aria-hidden", "false");
}


function closeNotCompletedModal() {
  state.activeNotCompletedTask = null;
  elements.notCompletedModal.classList.add("hidden");
  elements.notCompletedModal.setAttribute("aria-hidden", "true");
}


function handleNotCompletedSubmit(event) {
  event.preventDefault();

  const task = state.activeNotCompletedTask;
  if (!task) {
    setStatusMessage(elements.notCompletedMessage, "No task is selected.", "error");
    return;
  }

  const remarks = elements.notCompletedRemarks.value.trim();
  if (!remarks) {
    setStatusMessage(elements.notCompletedMessage, "Add a remark before submitting.", "error");
    return;
  }

  const completionKey = getCompletionKey(task);
  state.completions[completionKey] = {
    taskId: task.taskId || task.id,
    occurrenceDate: task.occurrenceDate,
    occurrenceSlot: task.occurrenceSlot || null,
    occurrenceSlotLabel: task.occurrenceSlotLabel || "",
    submittedAt: new Date().toISOString(),
    status: "not_completed",
    remarks,
    approvalStatus: "pending",
  };

  saveCompletions();
  syncSubmissionReport();
  closeNotCompletedModal();
  renderEmployeeTaskBoard();
  renderApprovalsPage();
}


function getCheckboxQuestionAnswer(question) {
  const yesInput = document.getElementById(`question-${question.id}-yes`);
  const noInput = document.getElementById(`question-${question.id}-no`);
  if (yesInput?.checked) {
    return "Yes";
  }
  if (noInput?.checked) {
    return "No";
  }
  return "";
}


async function collectChecklistResponses(template) {
  const responses = {};
  for (const question of template.questions) {
    if (question.type === "checkbox") {
      const answer = getCheckboxQuestionAnswer(question);
      responses[question.id] = answer;
      if (question.followUpOnNo) {
        const followUpField = document.getElementById(`question-${question.id}-followup`);
        responses[question.followUpOnNo.id] = answer === "No" ? followUpField?.value || "" : "";
      }
      continue;
    }

    const field = elements.checklistForm.elements.namedItem(question.id);
    if (!field) {
      continue;
    }

    if (question.type === "file" || question.type === "photo") {
      responses[question.id] = [];
      for (const file of [...field.files]) {
        responses[question.id].push(await uploadChecklistAttachment(file));
      }
      continue;
    }

    responses[question.id] = field.value;
  }

  return responses;
}


async function uploadChecklistAttachment(file) {
  const maxBytes = 3 * 1024 * 1024;

  // Images are normally shrunk the moment they're picked; this is the backstop
  // for a checklist submitted before that finished, or for a field rendered
  // outside the checklist form.
  let payload = file;
  if (payload.size > maxBytes && isCompressibleImage(payload)) {
    try {
      payload = await compressImageFile(payload);
    } catch (error) {
      payload = file;
    }
  }

  if (payload.size > maxBytes) {
    throw new Error(
      `"${file.name}" is ${formatFileSize(file.size)}, over the 3 MB limit. Please upload a smaller file.`,
    );
  }

  const fileBytes = new Uint8Array(await payload.arrayBuffer());
  let binary = "";
  fileBytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const response = await fetch(buildApiUrl("/api/checklist-attachments"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name: payload.name, type: payload.type, data: btoa(binary) }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `Could not upload "${file.name}".`);
  }
  return { name: result.name, pathname: result.pathname, contentType: result.contentType, size: result.size };
}


function collectCashDenominationRows() {
  return [...elements.checklistFields.querySelectorAll(".cash-denom-input")].map((input) => {
    const denomination = Number(input.getAttribute("data-cash-denom"));
    const notes = Number(input.value) || 0;
    return { denomination, notes, amount: denomination * notes };
  });
}


function collectCashCoinRows() {
  return [...elements.checklistFields.querySelectorAll(".cash-coin-input")].map((input) => {
    const denomination = Number(input.getAttribute("data-cash-coin-denom"));
    const count = Number(input.value) || 0;
    return { denomination, count, amount: denomination * count };
  });
}


function setHomeDefaults() {
  elements.dashboardDateInput.value = state.adminDate;
  if (elements.pcMonitorDateInput) {
    elements.pcMonitorDateInput.value = state.pcMonitorDate || todayValue();
  }
  elements.dateRangeSelect.value = "today";
  elements.taskSelect.value = "all";
  if (elements.absenceDateInput) {
    elements.absenceDateInput.value = todayValue();
  }
}


function restoreSession() {
  const token = getAuthToken();
  const savedEmail = localStorage.getItem(STORAGE_KEYS.session);
  if (String(savedEmail || "").toLowerCase() === "ups021980@gmail.com") {
    localStorage.removeItem(STORAGE_KEYS.session);
    clearAuthToken();
    toggleViews(false);
    return;
  }
  if (!savedEmail || !token) {
    if (!token) {
      localStorage.removeItem(STORAGE_KEYS.session);
    }
    toggleViews(false);
    return;
  }

  const matchedUser = state.users.find((user) => user.email === savedEmail);
  if (!matchedUser) {
    localStorage.removeItem(STORAGE_KEYS.session);
    toggleViews(false);
    return;
  }

  state.activeUser = matchedUser;
  state.currentView = state.currentView === "home" ? getDefaultViewForUser(matchedUser) : allowedView(state.currentView);
  toggleViews(true);
}


function restoreRememberedEmail() {
  const rememberedEmail = localStorage.getItem(STORAGE_KEYS.rememberedEmail);
  if (!rememberedEmail) {
    return;
  }

  elements.emailInput.value = rememberedEmail;
  elements.rememberMe.checked = true;
}


function setCurrentView(view) {
  state.currentView = allowedView(view);
  window.location.hash = state.currentView;
  if (state.currentView === "approvals" && !elements.approvalsDateInput.value) {
    elements.approvalsDateInput.value = getDefaultApprovalsDateForUser(state.activeUser);
  }
  if (state.currentView === "home") {
    state.employeeTaskPage = 1;
  }
  // Switch instantly using whatever is already cached, so navigation never
  // feels blocked on the network — then pull the latest data from the
  // server and re-render, so every tab click reflects real server state
  // rather than a stale in-memory copy from page load.
  renderDashboard();
  refreshStateFromServer().then(renderDashboard);
  syncLiveMapRefreshTimer();
}


function allowedView(view) {
  const isPcUser = isPcMonitorUser(state.activeUser);
  if (view === "buddy" && !isPcUser) {
    return "buddy";
  }
  if (view === "contacts") {
    return "contacts";
  }
  if (view === "users" && canManageUsers(state.activeUser)) {
    return "users";
  }
  if (view === "approvals" && !isPcUser && canMonitorChecklists(state.activeUser)) {
    return "approvals";
  }
  if (view === "compliance" && !isPcUser && canMonitorChecklists(state.activeUser)) {
    return "compliance";
  }
  return "home";
}


function enforceAllowedView() {
  const safeView = allowedView(state.currentView);
  if (safeView !== state.currentView) {
    state.currentView = safeView;
    window.location.hash = safeView;
  }
}


function toggleSidebar() {
  state.isSidebarCollapsed = !state.isSidebarCollapsed;
  renderSidebarState();
}


function collapseSidebar() {
  state.isSidebarCollapsed = true;
  renderSidebarState();
}
