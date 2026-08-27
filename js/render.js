// render.js — extracted from app.js (29 declarations)

function renderDashboard() {
  toggleViews(Boolean(state.activeUser));
  if (!state.activeUser) {
    return;
  }

  enforceAllowedView();
  renderSidebarState();
  renderSidebarVisibility();
  renderCurrentView();
  renderHomeDashboard();
  renderStats();
  renderUserDirectory();
  renderPasswordResetRequestsPanel();
  renderApprovalsPage();
  renderCompliancePage();
  renderBuddyPage();
  renderContactDirectory();
  renderLiveShareBanner();
}


function renderHomeDashboard() {
  if (!state.activeUser) {
    return;
  }

  const isAdminUser = isAdmin(state.activeUser);
  elements.homeTitle.textContent = isAdminUser ? `Welcome back, ${state.activeUser.name}` : `${state.activeUser.name} Dashboard`;
  elements.homeSubtitle.textContent = getDashboardSubtitle(state.activeUser);
  elements.adminWelcome.textContent = `Welcome back, ${state.activeUser.name}`;
  elements.employeeWelcome.textContent = `Welcome back, ${state.activeUser.name}`;
  elements.adminDashboardPanel.classList.toggle("hidden", !isAdminUser);
  elements.employeeDashboardPanel.classList.toggle("hidden", isAdminUser);
  elements.openAssignTaskButton.classList.toggle("hidden", !canAssignTasks(state.activeUser));

  if (isAdminUser) {
    renderAdminTaskBoard();
  } else {
    renderEmployeeTaskBoard();
  }

  renderPantryAlertsPanel();
  renderKamalApprovalPanel();
  renderKamalFuelRequestsPanel();
  renderFuelApprovalPanel();
  renderArunApprovalPanel();
  renderBuddyCoverageBanner();
}


function renderBuddyCoverageBanner() {
  const alerts = getCoverageEntriesForDate(todayValue()).filter((entry) =>
    entry.buddies.some((buddy) => isBuddyMatchForUser(buddy, entry.department, state.activeUser))
  );

  elements.buddyCoverageBanner.classList.toggle("hidden", !alerts.length);
  elements.buddyCoverageBanner.innerHTML = alerts.map(createBuddyCoverageBannerItem).join("");
}


function createBuddyCoverageBannerItem(entry) {
  const message =
    entry.type === "Week Off"
      ? `It's <strong>${escapeHtml(entry.employee)}</strong>'s week off today — you're covering their tasks.`
      : `<strong>${escapeHtml(entry.employee)}</strong> is marked ${escapeHtml(entry.type.toLowerCase())} today — you're covering their tasks.`;

  return `
    <div class="buddy-coverage-banner__item">
      <span>🔔</span>
      <span>${message}</span>
    </div>
  `;
}


function renderAdminTaskBoard() {
  const selectedDate = elements.dashboardDateInput.value;
  const searchQuery = state.homeSearch;

  const visibleTasks = state.tasks.filter((task) => {
    const createdByUser = task.assignedByEmail.toLowerCase() === state.activeUser.email.toLowerCase();
    const matchesDate = !selectedDate || taskOccursOnDate(task, selectedDate);
    const searchableText = [task.title, task.assigneeName, task.department, task.taskId, getFrequencyLabel(getTaskDisplayFrequency(task))]
      .join(" ")
      .toLowerCase();
    const matchesSearch = !searchQuery || searchableText.includes(searchQuery);
    return createdByUser && matchesDate && matchesSearch && task.active !== false;
  });

  const groupedTasks = groupAdminTasksByAssignee(visibleTasks);
  elements.adminBoardMeta.textContent = `${visibleTasks.length} active task${visibleTasks.length === 1 ? "" : "s"} across ${groupedTasks.length} employee${groupedTasks.length === 1 ? "" : "s"}`;
  elements.adminTaskBoard.innerHTML = "";
  elements.adminBoardPagination.innerHTML = "";

  if (!visibleTasks.length) {
    elements.adminTaskBoard.append(
      createEmptyState("No tasks match the current search or date. Assign a task to start the admin board.")
    );
    return;
  }

  const pageSize = ADMIN_BOARD_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(groupedTasks.length / pageSize));
  if (state.adminBoardPage > totalPages) {
    state.adminBoardPage = totalPages;
  }
  if (state.adminBoardPage < 1) {
    state.adminBoardPage = 1;
  }

  const startIndex = (state.adminBoardPage - 1) * pageSize;
  const pageGroups = groupedTasks.slice(startIndex, startIndex + pageSize);

  pageGroups.forEach((group) => {
    elements.adminTaskBoard.append(createAdminTaskCard(group));
  });

  renderAdminBoardPagination(totalPages);
}

const ADMIN_BOARD_PAGE_SIZE = 4;

function renderAdminBoardPagination(totalPages) {
  elements.adminBoardPagination.innerHTML = "";
  if (totalPages <= 1) {
    return;
  }

  const goToPage = (page) => {
    state.adminBoardPage = page;
    renderAdminTaskBoard();
  };

  const prevButton = document.createElement("button");
  prevButton.type = "button";
  prevButton.className = "pagination-button";
  prevButton.textContent = "‹";
  prevButton.disabled = state.adminBoardPage === 1;
  prevButton.addEventListener("click", () => goToPage(state.adminBoardPage - 1));
  elements.adminBoardPagination.append(prevButton);

  for (let page = 1; page <= totalPages; page++) {
    const pageButton = document.createElement("button");
    pageButton.type = "button";
    pageButton.className = "pagination-button" + (page === state.adminBoardPage ? " active" : "");
    pageButton.textContent = String(page);
    pageButton.addEventListener("click", () => goToPage(page));
    elements.adminBoardPagination.append(pageButton);
  }

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "pagination-button";
  nextButton.textContent = "›";
  nextButton.disabled = state.adminBoardPage === totalPages;
  nextButton.addEventListener("click", () => goToPage(state.adminBoardPage + 1));
  elements.adminBoardPagination.append(nextButton);
}


function renderPantryAlertsPanel() {
  if (!elements.pantryAlertsSection) {
    return;
  }

  const canView = canAssignTasks(state.activeUser);
  elements.pantryAlertsSection.classList.toggle("hidden", !canView);
  if (!canView) {
    return;
  }

  const alerts = state.pantryAlerts;
  elements.pantryAlertsMeta.textContent = `${alerts.length} quantity mismatch${alerts.length === 1 ? "" : "es"} reported`;
  elements.pantryAlertsBoard.innerHTML = "";

  if (!alerts.length) {
    elements.pantryAlertsBoard.append(createEmptyState("No pantry quantity mismatches have been reported."));
  } else {
    alerts.forEach((alert) => {
      elements.pantryAlertsBoard.append(createPantryAlertCard(alert));
    });
  }

  // Expanding pantry alerts takes over the whole admin dashboard rather than
  // living alongside the task board — re-applied on every render (not just
  // on toggle) so a background data refresh never snaps an open panel shut.
  elements.pantryAlertsToggle.setAttribute("aria-expanded", String(state.pantryAlertsExpanded));
  elements.pantryAlertsBoard.classList.toggle("hidden", !state.pantryAlertsExpanded);
  elements.adminDashboardMain?.classList.toggle("hidden", state.pantryAlertsExpanded);
}


function createPantryAlertCard(alert) {
  const diff = alert.submittedQuantity - alert.expectedQuantity;
  const diffLabel = diff > 0 ? `Over by ${diff}` : `Short by ${Math.abs(diff)}`;

  const card = document.createElement("article");
  card.className = "task-card task-card--alert";
  card.innerHTML = `
    <div class="task-card__top">
      <div>
        <strong>${escapeHtml(alert.item)}</strong>
      </div>
      <span class="task-badge task-badge--alert">${escapeHtml(diffLabel)}</span>
    </div>
    <div class="task-card__meta">
      <span>Reported by ${escapeHtml(alert.employeeName)} · ${escapeHtml(alert.location)}</span>
      <span>Counted ${escapeHtml(String(alert.submittedQuantity))} / Expected ${escapeHtml(String(alert.expectedQuantity))}</span>
      <span>${escapeHtml(formatDateValue(alert.occurrenceDate))}</span>
    </div>
  `;
  return card;
}


function renderKamalApprovalPanel() {
  if (!elements.kamalApprovalSection) {
    return;
  }

  const isKamal = state.activeUser?.email?.toLowerCase() === "kamal@modesigns.in";
  elements.kamalApprovalSection.classList.toggle("hidden", !isKamal);
  if (!isKamal) {
    return;
  }

  const pendingEntries = getPendingKamalApprovalEntries();
  elements.kamalApprovalMeta.textContent = `${pendingEntries.length} checklist${pendingEntries.length === 1 ? "" : "s"} awaiting your approval`;
  elements.kamalApprovalBoard.innerHTML = "";

  if (!pendingEntries.length) {
    elements.kamalApprovalBoard.append(createEmptyState("No checklists are waiting for your approval."));
    return;
  }

  pendingEntries.forEach((entry) => {
    elements.kamalApprovalBoard.append(createKamalApprovalCard(entry));
  });
}


function createKamalApprovalCard(entry) {
  const { completion, task } = entry;
  const isHrFuelFlag = completion.hrApprovalStatus === "pending";
  const card = document.createElement("article");
  card.className = "task-card task-card--alert";
  card.innerHTML = `
    <div class="task-card__top">
      <div>
        <strong>${escapeHtml(getTaskDisplayTitle(task))}</strong>
      </div>
      <span class="task-badge task-badge--alert">${isHrFuelFlag ? "Contact HR" : "Awaiting your approval"}</span>
    </div>
    <div class="task-card__meta">
      <span>Submitted by ${escapeHtml(task.assigneeName)} · Task ID ${escapeHtml(task.taskId || task.id)}</span>
      <span>${escapeHtml(formatDateValue(completion.occurrenceDate))}</span>
      ${
        isHrFuelFlag && Number.isFinite(completion.fuelMileage)
          ? `<span>Mileage ${escapeHtml(completion.fuelMileage.toFixed(1))} km/l — at or below the ${escapeHtml(String(completion.fuelMileageThreshold ?? "-"))} km/l threshold</span>`
          : ""
      }
    </div>
    <button type="button" class="button button--primary" data-kamal-approve-completion="${escapeHtml(entry.key)}">Approve</button>
  `;
  return card;
}


function renderFuelApprovalPanel() {
  if (!elements.fuelApprovalSection) {
    return;
  }

  const isFuelApprover = isFuelRequestApprover(state.activeUser?.email);
  elements.fuelApprovalSection.classList.toggle("hidden", !isFuelApprover);
  if (!isFuelApprover) {
    return;
  }

  const pendingEntries = getPendingFuelRequestApprovalEntries();
  elements.fuelApprovalMeta.textContent = `${pendingEntries.length} fuel request${pendingEntries.length === 1 ? "" : "s"} awaiting your approval`;
  elements.fuelApprovalBoard.innerHTML = "";

  if (!pendingEntries.length) {
    elements.fuelApprovalBoard.append(createEmptyState("No fuel requests are waiting for your approval."));
    return;
  }

  pendingEntries.forEach((entry) => {
    elements.fuelApprovalBoard.append(createFuelApprovalCard(entry));
  });
}


function createFuelApprovalCard(entry) {
  const { completion, task } = entry;
  const card = document.createElement("article");
  card.className = "task-card task-card--alert";
  card.innerHTML = `
    <div class="task-card__top">
      <div>
        <strong>${escapeHtml(task.assigneeName)}</strong>
      </div>
      <span class="task-badge task-badge--alert">Awaiting your approval</span>
    </div>
    <div class="task-card__meta">
      <span>Requested ${escapeHtml(formatDateValue(completion.occurrenceDate))}</span>
    </div>
    <button type="button" class="button button--primary" data-fuel-approve-completion="${escapeHtml(entry.key)}">Approve</button>
  `;
  return card;
}


function renderArunApprovalPanel() {
  if (!elements.arunApprovalSection) {
    return;
  }

  const isArun = state.activeUser?.email?.toLowerCase() === "arunmishra@modesigns.in";
  elements.arunApprovalSection.classList.toggle("hidden", !isArun);
  if (!isArun) {
    return;
  }

  const pendingEntries = getPendingArunApprovalEntries();
  elements.arunApprovalMeta.textContent = `${pendingEntries.length} checklist${pendingEntries.length === 1 ? "" : "s"} awaiting your review`;
  elements.arunApprovalBoard.innerHTML = "";

  if (!pendingEntries.length) {
    elements.arunApprovalBoard.append(createEmptyState("No checklists are waiting for your review."));
    return;
  }

  pendingEntries.forEach((entry) => {
    elements.arunApprovalBoard.append(createArunApprovalCard(entry));
  });
}


function createArunApprovalCard(entry) {
  const { completion, task } = entry;
  const card = document.createElement("article");
  card.className = "task-card task-card--alert";
  card.innerHTML = `
    <div class="task-card__top">
      <div>
        <strong>${escapeHtml(getTaskDisplayTitle(task))}</strong>
      </div>
      <span class="task-badge task-badge--alert">Awaiting your approval</span>
    </div>
    <div class="task-card__meta">
      <span>Submitted by ${escapeHtml(task.assigneeName)} · Task ID ${escapeHtml(task.taskId || task.id)}</span>
      <span>${escapeHtml(formatDateValue(completion.occurrenceDate))}</span>
    </div>
    <button type="button" class="button button--primary" data-arun-approve-completion="${escapeHtml(entry.key)}">Approve</button>
  `;
  return card;
}


function renderKamalFuelRequestsPanel() {
  if (!elements.kamalFuelRequestsSection) {
    return;
  }

  const isKamal = state.activeUser?.email?.toLowerCase() === "kamal@modesigns.in";
  elements.kamalFuelRequestsSection.classList.toggle("hidden", !isKamal);
  if (!isKamal) {
    return;
  }

  const dueRequests = getPendingFuelRequests();
  elements.kamalFuelRequestsMeta.textContent = `${dueRequests.length} driver${dueRequests.length === 1 ? "" : "s"} due for fuel`;
  elements.kamalFuelRequestsBoard.innerHTML = "";

  if (!dueRequests.length) {
    elements.kamalFuelRequestsBoard.append(createEmptyState("No drivers are due for a fuel refill right now."));
    return;
  }

  dueRequests.forEach((request) => {
    elements.kamalFuelRequestsBoard.append(createFuelRequestCard(request));
  });
}


function createFuelRequestCard(request) {
  const card = document.createElement("article");
  card.className = "task-card task-card--alert";
  card.innerHTML = `
    <div class="task-card__top">
      <div>
        <strong>${escapeHtml(request.user.name)}</strong>
      </div>
      <span class="task-badge task-badge--alert">${escapeHtml(String(request.kmSinceLastFill))} km since last fill</span>
    </div>
    <div class="task-card__meta">
      <span>${escapeHtml(request.vehicleType)} · Vehicle ${escapeHtml(request.vehicleNumber)} · Threshold ${escapeHtml(String(request.threshold))} km</span>
      <span>Last filled ${escapeHtml(formatDateValue(toDateValue(request.lastFilledAt)))}</span>
    </div>
  `;
  return card;
}


function renderApprovalsPage() {
  if (!elements.approvalsPage) {
    return;
  }

  const canView = canAssignTasks(state.activeUser);
  if (!canView) {
    elements.approvalsPendingBoard.innerHTML = "";
    elements.approvalsCompletedBoard.innerHTML = "";
    elements.approvalsNotCompletedBoard.innerHTML = "";
    elements.approvalsApprovedBoard.innerHTML = "";
    elements.approvalsPendingPagination.innerHTML = "";
    elements.approvalsCompletedPagination.innerHTML = "";
    elements.approvalsNotCompletedPagination.innerHTML = "";
    elements.approvalsApprovedPagination.innerHTML = "";
    return;
  }

  elements.approvalsDateInput.value = elements.approvalsDateInput.value || todayValue();
  const selectedDate = elements.approvalsDateInput.value;
  const selectedDateObject = new Date(`${selectedDate}T00:00:00`);

  const submittedEntries = Object.entries(state.completions)
    .filter(([, completion]) => completion.occurrenceDate === selectedDate && !completion.visitNumber)
    .map(([key, completion]) => {
      const baseTask = state.tasks.find(
        (item) => String(item.taskId || item.id) === String(completion.taskId)
      );
      const task = baseTask
        ? createTaskOccurrence(baseTask, selectedDateObject, {
            occurrenceSlot: completion.occurrenceSlot,
            occurrenceSlotLabel: completion.occurrenceSlotLabel,
          })
        : null;
      return task ? { key, completion, task } : null;
    })
    .filter(Boolean)
    .sort((left, right) => new Date(right.completion.submittedAt) - new Date(left.completion.submittedAt));

  const submittedOccurrenceKeys = new Set(submittedEntries.map((entry) => getCompletionKey(entry.task)));
  const notSubmitted = state.tasks
    .filter((task) => task.active !== false && taskOccursOnDate(task, selectedDate))
    .flatMap((task) => createTaskOccurrencesForDate(task, selectedDateObject))
    .filter((task) => isTaskCompletionEnabled(task))
    .filter((task) => !submittedOccurrenceKeys.has(getCompletionKey(task)))
    .map((task) => ({ task }))
    .sort((left, right) => (left.task.assigneeName || "").localeCompare(right.task.assigneeName || ""));

  const visibleEntries = submittedEntries.filter(
    (entry) =>
      entry.completion.kamalApprovalStatus !== "pending" &&
      entry.completion.hrApprovalStatus !== "pending" &&
      entry.completion.cashierApprovalStatus !== "pending" &&
      entry.completion.arunApprovalStatus !== "pending" &&
      entry.completion.fuelRequestApprovalStatus !== "pending"
  );
  const completed = visibleEntries.filter(
    (entry) => entry.completion.approvalStatus !== "approved" && entry.completion.status !== "not_completed"
  );
  const notCompleted = visibleEntries.filter(
    (entry) => entry.completion.approvalStatus !== "approved" && entry.completion.status === "not_completed"
  );
  const approved = visibleEntries.filter((entry) => entry.completion.approvalStatus === "approved");

  elements.approvalsPendingMeta.textContent = `${notSubmitted.length} task${notSubmitted.length === 1 ? "" : "s"} not yet submitted`;
  elements.approvalsCompletedMeta.textContent = `${completed.length} submission${completed.length === 1 ? "" : "s"} awaiting review`;
  elements.approvalsNotCompletedMeta.textContent = `${notCompleted.length} "not completed" submission${notCompleted.length === 1 ? "" : "s"} awaiting review`;
  elements.approvalsApprovedMeta.textContent = `${approved.length} submission${approved.length === 1 ? "" : "s"} approved`;
  elements.approvalsPendingTabCount.textContent = String(notSubmitted.length);
  elements.approvalsCompletedTabCount.textContent = String(completed.length);
  elements.approvalsNotCompletedTabCount.textContent = String(notCompleted.length);
  elements.approvalsApprovedTabCount.textContent = String(approved.length);

  const activeTab = ["pending", "completed", "notcompleted", "approved", "live"].includes(state.approvalsTab)
    ? state.approvalsTab
    : "pending";
  elements.approvalsPendingSection.classList.toggle("hidden", activeTab !== "pending");
  elements.approvalsCompletedSection.classList.toggle("hidden", activeTab !== "completed");
  elements.approvalsNotCompletedSection.classList.toggle("hidden", activeTab !== "notcompleted");
  elements.approvalsApprovedSection.classList.toggle("hidden", activeTab !== "approved");
  elements.approvalsLiveSection.classList.toggle("hidden", activeTab !== "live");
  elements.approvalsTabNav.querySelectorAll("[data-approvals-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.getAttribute("data-approvals-tab") === activeTab);
  });

  renderGroupedApprovalRows(notSubmitted, {
    board: elements.approvalsPendingBoard,
    emptyState: elements.approvalsPendingEmpty,
    pagination: elements.approvalsPendingPagination,
    pageKey: "approvalsPendingPage",
    headerRow: "<th>Task</th><th>Department</th><th>Task ID</th><th>Planned</th><th>Status</th>",
    createRow: createNotSubmittedRow,
    countLabel: (count) => `task${count === 1 ? "" : "s"} pending`,
  });

  renderGroupedApprovalRows(completed, {
    board: elements.approvalsCompletedBoard,
    emptyState: elements.approvalsCompletedEmpty,
    pagination: elements.approvalsCompletedPagination,
    pageKey: "approvalsCompletedPage",
    headerRow: "<th>Task</th><th>Department</th><th>Task ID</th><th>Submitted</th><th>Details</th><th>Action</th>",
    createRow: (entry) => createApprovalRow(entry, true),
    countLabel: (count) => `submission${count === 1 ? "" : "s"} awaiting review`,
  });

  renderGroupedApprovalRows(notCompleted, {
    board: elements.approvalsNotCompletedBoard,
    emptyState: elements.approvalsNotCompletedEmpty,
    pagination: elements.approvalsNotCompletedPagination,
    pageKey: "approvalsNotCompletedPage",
    headerRow: "<th>Task</th><th>Department</th><th>Task ID</th><th>Submitted</th><th>Reason</th><th>Action</th>",
    createRow: (entry) => createApprovalRow(entry, true),
    countLabel: (count) => `"not completed" submission${count === 1 ? "" : "s"} awaiting review`,
  });

  renderGroupedApprovalRows(approved, {
    board: elements.approvalsApprovedBoard,
    emptyState: elements.approvalsApprovedEmpty,
    pagination: elements.approvalsApprovedPagination,
    pageKey: "approvalsApprovedPage",
    headerRow: "<th>Task</th><th>Department</th><th>Task ID</th><th>Submitted</th><th>Details</th><th>Approved by</th>",
    createRow: (entry) => createApprovalRow(entry, false),
    countLabel: (count) => `submission${count === 1 ? "" : "s"} approved`,
  });

  renderApprovalsLivePage(activeTab === "live");
}


function renderApprovalsLivePage(isVisible) {
  const now = Date.now();
  const activeShares = Object.values(state.liveLocations).filter((share) => share.expiresAt > now);

  elements.approvalsLiveTabCount.textContent = String(activeShares.length);
  elements.approvalsLiveMeta.textContent = `${activeShares.length} employee${activeShares.length === 1 ? "" : "s"} sharing live location`;
  elements.approvalsLiveEmpty.classList.toggle("hidden", activeShares.length > 0);
  elements.approvalsLiveList.innerHTML = "";

  activeShares
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .forEach((share) => {
      elements.approvalsLiveList.append(createLiveLocationCard(share));
    });

  if (isVisible) {
    renderLiveMap(activeShares);
  }
}


function createLiveLocationCard(share) {
  const card = document.createElement("div");
  card.className = "live-location-card";
  const updatedLabel = new Date(share.updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const expiresLabel = new Date(share.expiresAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  card.innerHTML = `
    <div>
      <strong>${escapeHtml(share.employeeName)}</strong>
      <div class="live-location-card__meta">
        ${share.taskTitle ? `${escapeHtml(share.taskTitle)} · ` : ""}Updated ${updatedLabel} · Sharing until ${expiresLabel}
      </div>
    </div>
    <a class="text-button" href="https://www.google.com/maps?q=${encodeURIComponent(share.lat)},${encodeURIComponent(share.lng)}" target="_blank" rel="noopener">Open in Google Maps</a>
  `;
  return card;
}


function renderLiveMap(shares) {
  if (typeof L === "undefined" || !elements.liveLocationMap) {
    return;
  }

  if (!state.liveMapInstance) {
    state.liveMapInstance = L.map(elements.liveLocationMap).setView([20.5937, 78.9629], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(state.liveMapInstance);
  }

  const seenEmails = new Set();
  shares.forEach((share) => {
    seenEmails.add(share.employeeEmail);
    const latLng = [share.lat, share.lng];
    if (state.liveMapMarkers[share.employeeEmail]) {
      state.liveMapMarkers[share.employeeEmail].setLatLng(latLng);
    } else {
      state.liveMapMarkers[share.employeeEmail] = L.marker(latLng).addTo(state.liveMapInstance);
    }
    state.liveMapMarkers[share.employeeEmail].bindPopup(
      `<strong>${escapeHtml(share.employeeName)}</strong><br>${escapeHtml(share.taskTitle || "")}`
    );
  });

  Object.keys(state.liveMapMarkers).forEach((email) => {
    if (!seenEmails.has(email)) {
      state.liveMapInstance.removeLayer(state.liveMapMarkers[email]);
      delete state.liveMapMarkers[email];
    }
  });

  if (shares.length) {
    const bounds = L.latLngBounds(shares.map((share) => [share.lat, share.lng]));
    state.liveMapInstance.fitBounds(bounds, { maxZoom: 15, padding: [30, 30] });
  }

  setTimeout(() => state.liveMapInstance.invalidateSize(), 0);
}


function groupEntriesByAssignee(entries) {
  const groups = new Map();
  entries.forEach((entry) => {
    const task = entry.task;
    const key = task.assigneeEmail?.toLowerCase() || task.assigneeName?.toLowerCase() || "-";
    if (!groups.has(key)) {
      groups.set(key, {
        assigneeName: task.assigneeName || "-",
        department: task.department,
        entries: [],
      });
    }
    groups.get(key).entries.push(entry);
  });

  return [...groups.values()].sort((left, right) => left.assigneeName.localeCompare(right.assigneeName));
}

const APPROVALS_GROUP_PAGE_SIZE = 4;

function renderGroupedApprovalRows(entries, { board, emptyState, pagination, pageKey, headerRow, createRow, countLabel }) {
  board.innerHTML = "";
  emptyState.classList.toggle("hidden", entries.length > 0);

  if (!entries.length) {
    pagination.innerHTML = "";
    return;
  }

  const groups = groupEntriesByAssignee(entries);
  const totalPages = Math.max(1, Math.ceil(groups.length / APPROVALS_GROUP_PAGE_SIZE));
  if (state[pageKey] > totalPages) {
    state[pageKey] = totalPages;
  }
  if (state[pageKey] < 1) {
    state[pageKey] = 1;
  }

  const startIndex = (state[pageKey] - 1) * APPROVALS_GROUP_PAGE_SIZE;
  const pageGroups = groups.slice(startIndex, startIndex + APPROVALS_GROUP_PAGE_SIZE);

  pageGroups.forEach((group) => {
    board.append(createApprovalGroupCard(group, { headerRow, createRow, countLabel }));
  });

  renderPaginationControls(pagination, state[pageKey], totalPages, (page) => {
    state[pageKey] = page;
    renderApprovalsPage();
  });
}


function createApprovalGroupCard(group, { headerRow, createRow, countLabel }) {
  const card = document.createElement("details");
  card.className = "task-card task-card--admin task-card--group";

  const rowsMarkup = group.entries.map((entry) => createRow(entry).outerHTML).join("");

  card.innerHTML = `
    <summary class="admin-task-summary">
      <div class="task-card__top">
        <div>
          <strong>${escapeHtml(group.assigneeName)}</strong>
          <div class="task-card__meta">
            <span>Department ${escapeHtml(normalizeValue(group.department))}</span>
          </div>
        </div>
        <span class="task-badge">${escapeHtml(String(group.entries.length))} ${escapeHtml(countLabel(group.entries.length))}</span>
      </div>
    </summary>
    <div class="table-shell">
      <table class="user-table">
        <thead><tr>${headerRow}</tr></thead>
        <tbody>${rowsMarkup}</tbody>
      </table>
    </div>
  `;
  return card;
}


function createNotSubmittedRow(entry) {
  const { task } = entry;
  const row = document.createElement("tr");
  row.innerHTML = `
    <td>${escapeHtml(getTaskDisplayTitle(task))}</td>
    <td>${escapeHtml(normalizeValue(task.department))}</td>
    <td>${escapeHtml(task.taskId || task.id)}</td>
    <td>${escapeHtml(formatTaskDate(task))}</td>
    <td><span class="task-badge task-badge--alert">Not submitted</span></td>
  `;
  return row;
}


function createApprovalRow(entry, isAwaitingApproval) {
  const { key, completion, task } = entry;
  const row = document.createElement("tr");
  const submittedLabel = new Date(completion.submittedAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const actionCell = isAwaitingApproval
    ? `<button type="button" class="status-button" data-approve-completion="${escapeHtml(key)}">Approve</button>`
    : `<span class="status-badge">${escapeHtml(completion.approvedByName || "-")}</span>`;

  row.innerHTML = `
    <td>${escapeHtml(getTaskDisplayTitle(task))}</td>
    <td>${escapeHtml(normalizeValue(task.department))}</td>
    <td>${escapeHtml(task.taskId || task.id)}</td>
    <td>${escapeHtml(submittedLabel)}</td>
    <td>${escapeHtml(summarizeCompletion(task, completion))}</td>
    <td>${actionCell}</td>
  `;
  return row;
}


function summarizeCompletion(task, completion) {
  if (completion.status === "not_completed") {
    return `Not completed — ${completion.remarks || "no remark given"}`;
  }

  if (isSiteVisitTask(task) && completion.responses?.visits) {
    return `${SITE_VISIT_COUNT}/${SITE_VISIT_COUNT} site visits completed`;
  }

  if (isPantryTask(task)) {
    const items = completion.responses?.items || [];
    const mismatches = items.filter((row) => row.submittedQuantity !== row.expectedQuantity);
    const mismatchNote = mismatches.length
      ? `, ${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}`
      : "";
    return `${completion.location || "-"} pantry count — ${items.length} item${items.length === 1 ? "" : "s"}${mismatchNote}`;
  }

  const responses = completion.responses || {};
  const textAnswer = Object.values(responses).find(
    (value) => typeof value === "string" && value.trim()
  );
  if (textAnswer) {
    const trimmed = textAnswer.trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  }

  const fileCount = Object.values(responses)
    .filter((value) => Array.isArray(value))
    .reduce((total, files) => total + files.length, 0);
  if (fileCount) {
    return `${fileCount} file${fileCount === 1 ? "" : "s"} attached`;
  }

  return "Task marked complete";
}


function renderPaginationControls(container, currentPage, totalPages, onPageChange) {
  container.innerHTML = "";
  if (totalPages <= 1) {
    return;
  }

  const prevButton = document.createElement("button");
  prevButton.type = "button";
  prevButton.className = "pagination-button";
  prevButton.textContent = "‹";
  prevButton.disabled = currentPage === 1;
  prevButton.addEventListener("click", () => onPageChange(currentPage - 1));
  container.append(prevButton);

  for (let page = 1; page <= totalPages; page++) {
    const pageButton = document.createElement("button");
    pageButton.type = "button";
    pageButton.className = "pagination-button" + (page === currentPage ? " active" : "");
    pageButton.textContent = String(page);
    pageButton.addEventListener("click", () => onPageChange(page));
    container.append(pageButton);
  }

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "pagination-button";
  nextButton.textContent = "›";
  nextButton.disabled = currentPage === totalPages;
  nextButton.addEventListener("click", () => onPageChange(currentPage + 1));
  container.append(nextButton);
}


function renderWalkinCustomerBoard() {
  const today = todayValue();
  const myWalkinTasks = state.tasks
    .filter(
      (task) =>
        task.source === "walkin" && task.active !== false && isTaskAssignedToUser(task, state.activeUser)
    )
    // These are one-time tasks read directly (not run through
    // expandTaskForDateRange), so occurrenceDate has to be set by hand to
    // match what the normal occurrence pipeline would produce — every
    // completion-key/availability helper below depends on it being present.
    .map((task) => ({ ...task, occurrenceDate: task.plannedDate }));

  const groupsById = new Map();
  myWalkinTasks.forEach((task) => {
    if (!groupsById.has(task.walkinId)) {
      groupsById.set(task.walkinId, {
        walkinId: task.walkinId,
        customerName: task.customerName,
        walkinDate: task.walkinDate,
        department: task.department,
        details: task.details,
        tasks: [],
      });
    }
    groupsById.get(task.walkinId).tasks.push(task);
  });

  // Strictly today's handovers only — a customer disappears at midnight
  // regardless of whether their checklist was finished, and tomorrow's
  // handovers replace them.
  const groups = [...groupsById.values()]
    .map((group) => {
      const completedCount = group.tasks.filter((task) => getCompletionRecord(task)).length;
      return { ...group, completedCount, total: group.tasks.length };
    })
    .filter((group) => group.walkinDate === today)
    .sort((left, right) => left.customerName.localeCompare(right.customerName));

  state.visibleWalkinTasks = groups.flatMap((group) => group.tasks);
  // Used by the generic (non-walkin) task rows below to also attribute them
  // to today's customer(s) — one row per customer, each independently
  // completable, mirroring how the walk-in board itself behaves.
  state.todayWalkinCustomers = groups.map((group) => ({
    walkinId: group.walkinId,
    customerName: group.customerName,
  }));

  elements.walkinCustomerMeta.textContent = groups.length
    ? `${groups.length} customer${groups.length === 1 ? "" : "s"} handed over to you today`
    : "";

  elements.walkinCustomerBoard.innerHTML = "";
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "board-meta";
    empty.textContent = "No walk-in customers are waiting on you.";
    elements.walkinCustomerBoard.append(empty);
    return;
  }

  groups.forEach((group) => {
    elements.walkinCustomerBoard.append(createWalkinCustomerCard(group));
  });
}


function createWalkinCustomerCard(group) {
  const card = document.createElement("details");
  card.className = "task-card task-card--group";

  const tasksMarkup = group.tasks
    .map((task) => {
      const completion = getCompletionRecord(task);
      const availability = getTaskAvailability(task);
      const actionMarkup = completion
        ? createCompletionStatusBadge(completion)
        : createTaskStatusSelect(task, availability);

      return `
        <article class="admin-task-item">
          <div class="admin-task-item__top">
            <strong>${escapeHtml(task.title)}</strong>
            <div class="admin-task-item__actions">${actionMarkup}</div>
          </div>
        </article>
      `;
    })
    .join("");

  card.innerHTML = `
    <summary class="admin-task-summary">
      <div class="task-card__top">
        <div>
          <strong>${escapeHtml(group.customerName)}</strong>
          <div class="task-card__meta">
            <span>${escapeHtml(formatDateValue(group.walkinDate))}</span>
            <span>Department ${escapeHtml(normalizeValue(group.department))}</span>
            ${group.details ? `<span>${escapeHtml(group.details)}</span>` : ""}
          </div>
        </div>
        <span class="task-badge">${escapeHtml(`${group.completedCount}/${group.total} tasks done`)}</span>
      </div>
    </summary>
    <div class="admin-task-list">
      ${tasksMarkup}
    </div>
  `;
  return card;
}


function renderEmployeeTaskBoard() {
  if (!state.activeUser) {
    return;
  }

  const taskTable = elements.employeeTaskTableBody.closest(".employee-task-table");
  if (taskTable) {
    taskTable.classList.toggle("hide-customer-columns", state.activeUser.role !== "salesman");
  }

  renderWalkinCustomerBoard();

  const myOwnTasks = state.tasks.filter(
    (task) => isTaskAssignedToUser(task, state.activeUser)
  );
  const departments = [...new Set(myOwnTasks.map((task) => normalizeValue(task.department)))]
    .filter((value) => value !== "-")
    .sort((left, right) => left.localeCompare(right));
  createSelectOptions(elements.departmentSelect, departments, "All departments", elements.departmentSelect.value);

  const dateRange = elements.dateRangeSelect.value;
  const taskFilter = elements.taskSelect.value;
  const departmentFilter = elements.departmentSelect.value;

  const occurrences = state.tasks
    .filter((task) => {
      const matchesTask = taskFilter === "all" || getTaskDisplayFrequency(task) === taskFilter;
      const matchesDepartment =
        departmentFilter === "all" || normalizeValue(task.department) === departmentFilter;
      return matchesTask && matchesDepartment && task.active !== false;
    })
    .flatMap((task) => {
      return expandTaskForDateRange(task, dateRange)
        .map((occurrence) => mapOccurrenceForViewer(occurrence, state.activeUser))
        .filter(Boolean);
    })
    .filter((task, index, allTasks) => {
      return index === allTasks.findIndex((item) => getTaskOccurrenceIdentity(item) === getTaskOccurrenceIdentity(task));
    })
    .sort((left, right) => {
      const dateDiff = getTaskReferenceDate(left) - getTaskReferenceDate(right);
      if (dateDiff !== 0) {
        return dateDiff;
      }
      return getTaskSequenceValue(left) - getTaskSequenceValue(right);
    });

  // Walk-in tasks get their own per-customer board (renderWalkinCustomerBoard
  // above) — keep them out of this flat table so they aren't shown twice.
  // Generic tasks landing on today get cloned once per today's customer
  // (each independently completable via customerAttributionKey feeding into
  // getCompletionKey/getTaskOccurrenceIdentity) so they're attributed the
  // same way the walk-in board's tasks already are.
  const today = todayValue();
  const displayOccurrences = occurrences
    .filter((task) => task.source !== "walkin")
    .flatMap((task) => {
      const occurrenceDate = task.occurrenceDate || task.plannedDate;
      if (occurrenceDate !== today || !state.todayWalkinCustomers.length) {
        return [task];
      }
      return state.todayWalkinCustomers.map((customer) => ({
        ...task,
        customerAttributionKey: customer.walkinId,
        customerAttributionName: customer.customerName,
      }));
    });

  // The click handler looks tasks up in this array by occurrence identity —
  // it must contain the actual (possibly per-customer-cloned) rows being
  // rendered, not the pre-clone list, or "Task completed" clicks on a cloned
  // row would fail to find their task.
  state.visibleEmployeeTasks = displayOccurrences;

  elements.employeeBoardMeta.textContent = `${displayOccurrences.length} assigned task${displayOccurrences.length === 1 ? "" : "s"} for the selected range`;
  elements.employeeTaskTableBody.innerHTML = "";
  elements.employeeTaskPagination.innerHTML = "";

  if (!displayOccurrences.length) {
    const emptyRow = document.createElement("tr");
    emptyRow.innerHTML = `<td colspan="7">No assigned tasks are visible for the selected filters.</td>`;
    elements.employeeTaskTableBody.append(emptyRow);
    sessionStorage.setItem("visibleTaskIds", JSON.stringify([]));
    return;
  }

  const pageSize = EMPLOYEE_TASK_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(displayOccurrences.length / pageSize));
  if (state.employeeTaskPage > totalPages) {
    state.employeeTaskPage = totalPages;
  }
  if (state.employeeTaskPage < 1) {
    state.employeeTaskPage = 1;
  }

  const startIndex = (state.employeeTaskPage - 1) * pageSize;
  const pageOccurrences = displayOccurrences.slice(startIndex, startIndex + pageSize);

  pageOccurrences.forEach((task) => {
    elements.employeeTaskTableBody.append(createEmployeeTaskRow(task));
  });

  // Task ID is no longer shown as a table column — kept in sessionStorage
  // instead, purely so it's still inspectable via DevTools if ever needed.
  sessionStorage.setItem("visibleTaskIds", JSON.stringify(pageOccurrences.map((task) => task.taskId || task.id)));

  renderEmployeeTaskPagination(totalPages);
}

const EMPLOYEE_TASK_PAGE_SIZE = 5;

function renderEmployeeTaskPagination(totalPages) {
  elements.employeeTaskPagination.innerHTML = "";
  if (totalPages <= 1) {
    return;
  }

  const goToPage = (page) => {
    state.employeeTaskPage = page;
    renderEmployeeTaskBoard();
  };

  const prevButton = document.createElement("button");
  prevButton.type = "button";
  prevButton.className = "pagination-button";
  prevButton.textContent = "‹";
  prevButton.disabled = state.employeeTaskPage === 1;
  prevButton.addEventListener("click", () => goToPage(state.employeeTaskPage - 1));
  elements.employeeTaskPagination.append(prevButton);

  for (let page = 1; page <= totalPages; page++) {
    const pageButton = document.createElement("button");
    pageButton.type = "button";
    pageButton.className = "pagination-button" + (page === state.employeeTaskPage ? " active" : "");
    pageButton.textContent = String(page);
    pageButton.addEventListener("click", () => goToPage(page));
    elements.employeeTaskPagination.append(pageButton);
  }

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "pagination-button";
  nextButton.textContent = "›";
  nextButton.disabled = state.employeeTaskPage === totalPages;
  nextButton.addEventListener("click", () => goToPage(state.employeeTaskPage + 1));
  elements.employeeTaskPagination.append(nextButton);
}


function renderStats() {
  elements.totalUsers.textContent = String(state.users.length);
  elements.adminUsers.textContent = String(countByRole("admin"));
  elements.salesUsers.textContent = String(countByRole("salesman"));
  elements.installerUsers.textContent = String(countByRole("installer"));
  elements.activeUserName.textContent = state.activeUser?.name ?? "Guest";
}


function renderPasswordResetRequestsPanel() {
  if (!elements.passwordResetRequestsPanel) {
    return;
  }

  const isAdminUser = isAdmin(state.activeUser);
  const pendingRequests = (state.passwordResetRequests || [])
    .filter((request) => !request.resolvedAt)
    .sort((left, right) => new Date(right.requestedAt) - new Date(left.requestedAt));

  elements.passwordResetRequestsPanel.classList.toggle("hidden", !isAdminUser || !pendingRequests.length);
  if (!isAdminUser) {
    return;
  }

  elements.passwordResetRequestsMeta.textContent = `${pendingRequests.length} request${pendingRequests.length === 1 ? "" : "s"} pending`;
  elements.passwordResetRequestsBoard.innerHTML = "";
  pendingRequests.forEach((request, index) => {
    elements.passwordResetRequestsBoard.append(createPasswordResetRequestCard(request, index));
  });
}


function createPasswordResetRequestCard(request, index) {
  const inputId = `passwordResetInput-${index}`;
  const card = document.createElement("article");
  card.className = "task-card task-card--alert";
  card.innerHTML = `
    <div class="task-card__top">
      <div>
        <strong>${escapeHtml(request.name || request.email)}</strong>
      </div>
      <span class="task-badge task-badge--alert">Password reset requested</span>
    </div>
    <div class="task-card__meta">
      <span>${escapeHtml(request.email)}</span>
      <span>Requested ${escapeHtml(formatDateValue(toDateValue(request.requestedAt)))}</span>
    </div>
    <div class="password-field password-field--inline">
      <input type="password" id="${inputId}" placeholder="Set a new password" minlength="6" />
      <button type="button" class="password-toggle" data-password-toggle="${inputId}" aria-label="Show password">👁</button>
    </div>
    <button type="button" class="button button--primary" data-resolve-reset-request="${escapeHtml(request.email)}" data-reset-input="${inputId}">Set password</button>
  `;
  return card;
}


const USER_TABLE_PAGE_SIZE = 10;

function renderUserDirectory() {
  const filteredUsers = getFilteredUsers();
  elements.userTableBody.innerHTML = "";
  elements.mobileCards.innerHTML = "";
  elements.userTablePagination.innerHTML = "";
  elements.emptyState.classList.toggle("hidden", filteredUsers.length > 0);

  if (!filteredUsers.length) {
    return;
  }

  const pageSize = USER_TABLE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  if (state.userTablePage > totalPages) {
    state.userTablePage = totalPages;
  }
  if (state.userTablePage < 1) {
    state.userTablePage = 1;
  }

  const startIndex = (state.userTablePage - 1) * pageSize;
  const pageUsers = filteredUsers.slice(startIndex, startIndex + pageSize);

  pageUsers.forEach((user) => {
    elements.userTableBody.append(createTableRow(user));
    elements.mobileCards.append(createMobileCard(user));
  });

  renderUserTablePagination(totalPages);
}


function renderUserTablePagination(totalPages) {
  elements.userTablePagination.innerHTML = "";
  if (totalPages <= 1) {
    return;
  }

  const goToPage = (page) => {
    state.userTablePage = page;
    renderUserDirectory();
  };

  const prevButton = document.createElement("button");
  prevButton.type = "button";
  prevButton.className = "pagination-button";
  prevButton.textContent = "‹";
  prevButton.disabled = state.userTablePage === 1;
  prevButton.addEventListener("click", () => goToPage(state.userTablePage - 1));
  elements.userTablePagination.append(prevButton);

  for (let page = 1; page <= totalPages; page++) {
    const pageButton = document.createElement("button");
    pageButton.type = "button";
    pageButton.className = "pagination-button" + (page === state.userTablePage ? " active" : "");
    pageButton.textContent = String(page);
    pageButton.addEventListener("click", () => goToPage(page));
    elements.userTablePagination.append(pageButton);
  }

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "pagination-button";
  nextButton.textContent = "›";
  nextButton.disabled = state.userTablePage === totalPages;
  nextButton.addEventListener("click", () => goToPage(state.userTablePage + 1));
  elements.userTablePagination.append(nextButton);
}


function renderBuddyPage() {
  const todayCoverage = getCoverageEntriesForDate(todayValue());
  const todayCoverageTasks = buildCoverageOccurrencesForDate(todayValue());

  elements.buddyCount.textContent = String(BUDDY_ASSIGNMENTS.length);
  elements.weekOffCount.textContent = String(
    todayCoverage.filter((item) => item.type === "Week Off").length
  );
  elements.absenceCount.textContent = String(
    todayCoverage.filter((item) => item.type === "Absent" || item.type === "Leave" || item.type === "Emergency").length
  );
  elements.coverageTaskCount.textContent = String(todayCoverageTasks.length);
  elements.absenceDateInput.value = elements.absenceDateInput.value || todayValue();

  elements.coverageList.innerHTML = "";
  if (!todayCoverage.length) {
    elements.coverageList.append(
      createEmptyState("No week off or absent coverage is active for Friday, July 17, 2026.")
    );
  } else {
    todayCoverage.forEach((item) => {
      elements.coverageList.append(createCoverageCard(item));
    });
  }

  const absencePanel = elements.absenceForm.closest(".panel");
  if (absencePanel) {
    absencePanel.classList.toggle("hidden", !canManageUsers(state.activeUser));
  }
}


const CONTACTS_PAGE_SIZE = 10;

// Serial numbers reflect each contact's fixed position in the source
// directory, not the filtered result order, so a search doesn't renumber them.
function getFilteredContacts() {
  const query = state.contactsQuery.trim().toLowerCase();
  const withNumbers = CONTACT_DIRECTORY.map((contact, index) => ({ contact, serialNumber: index + 1 }));
  if (!query) {
    return withNumbers;
  }
  return withNumbers.filter(({ contact }) => {
    const searchable = `${contact.name} ${contact.department} ${contact.location} ${contact.phone} ${contact.remark}`.toLowerCase();
    return searchable.includes(query);
  });
}

function renderContactDirectory() {
  if (!elements.contactsPage) {
    return;
  }

  elements.contactsCount.textContent = String(CONTACT_DIRECTORY.length);

  const filteredContacts = getFilteredContacts();
  elements.contactsTableBody.innerHTML = "";
  elements.contactsMobileCards.innerHTML = "";
  elements.contactsPagination.innerHTML = "";
  elements.contactsEmptyState.classList.toggle("hidden", filteredContacts.length > 0);

  if (!filteredContacts.length) {
    return;
  }

  const pageSize = CONTACTS_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filteredContacts.length / pageSize));
  if (state.contactsPage > totalPages) {
    state.contactsPage = totalPages;
  }
  if (state.contactsPage < 1) {
    state.contactsPage = 1;
  }

  const startIndex = (state.contactsPage - 1) * pageSize;
  const pageContacts = filteredContacts.slice(startIndex, startIndex + pageSize);

  pageContacts.forEach(({ contact, serialNumber }) => {
    elements.contactsTableBody.append(createContactRow(contact, serialNumber));
    elements.contactsMobileCards.append(createContactMobileCard(contact, serialNumber));
  });

  renderPaginationControls(elements.contactsPagination, state.contactsPage, totalPages, (page) => {
    state.contactsPage = page;
    renderContactDirectory();
  });
}


function createContactRow(contact, serialNumber) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td>${escapeHtml(String(serialNumber))}</td>
    <td class="name-cell"><strong>${escapeHtml(contact.name)}</strong></td>
    <td>${escapeHtml(normalizeValue(contact.department))}</td>
    <td>${escapeHtml(normalizeValue(contact.location))}</td>
    <td>${escapeHtml(contact.phone)}</td>
    <td>${escapeHtml(contact.remark)}</td>
  `;
  return row;
}


function createContactMobileCard(contact, serialNumber) {
  const card = document.createElement("article");
  card.className = "mobile-card";
  card.innerHTML = `
    <strong>${escapeHtml(String(serialNumber))}. ${escapeHtml(contact.name)}</strong>
    <div class="mobile-card__meta">Department: ${escapeHtml(normalizeValue(contact.department))}</div>
    <div class="mobile-card__meta">Location: ${escapeHtml(normalizeValue(contact.location))}</div>
    <div class="mobile-card__meta">Phone: ${escapeHtml(contact.phone)}</div>
    <div class="mobile-card__meta">Remark: ${escapeHtml(contact.remark)}</div>
  `;
  return card;
}


function renderCompliancePage() {
  if (!elements.compliancePage) {
    return;
  }

  // Default range only fills in once (both fields start empty) — later
  // renders (periodic refresh, etc.) respect whatever the admin has set.
  if (!elements.complianceStartDate.value) {
    elements.complianceStartDate.value = "2026-07-22";
  }
  if (!elements.complianceEndDate.value) {
    elements.complianceEndDate.value = todayValue();
  }

  const days = getComplianceReportForDateRange(elements.complianceStartDate.value, elements.complianceEndDate.value);
  const daysWithActivity = days.filter((day) => day.entries.length);

  const totalExpected = daysWithActivity.reduce((sum, day) => sum + day.entries.length, 0);
  const totalMissed = daysWithActivity.reduce((sum, day) => sum + day.missedCount, 0);
  elements.complianceMeta.textContent = totalExpected
    ? `${totalExpected} checklist${totalExpected === 1 ? "" : "s"} expected across ${daysWithActivity.length} day${daysWithActivity.length === 1 ? "" : "s"} · ${totalMissed} missed`
    : "";

  elements.complianceBoard.innerHTML = "";
  elements.complianceEmptyState.classList.toggle("hidden", daysWithActivity.length > 0);

  daysWithActivity
    .slice()
    .reverse()
    .forEach((day) => {
      elements.complianceBoard.append(createComplianceDayCard(day));
    });
}


function createComplianceDayCard(day) {
  const card = document.createElement("details");
  card.className = `task-card task-card--group${day.missedCount ? " task-card--alert" : ""}`;

  const rowsMarkup = day.entries
    .map(
      (entry) => `
        <tr>
          <td>${escapeHtml(entry.task.assigneeName || "-")}</td>
          <td>${escapeHtml(getTaskDisplayTitle(entry.task))}</td>
          <td>${
            entry.completion
              ? '<span class="status-badge">Completed</span>'
              : '<span class="status-badge status-badge--alert">Not submitted</span>'
          }</td>
        </tr>
      `
    )
    .join("");

  card.innerHTML = `
    <summary class="admin-task-summary">
      <div class="task-card__top">
        <div>
          <strong>${escapeHtml(formatDateValue(day.date))}</strong>
        </div>
        <span class="task-badge${day.missedCount ? " task-badge--alert" : ""}">
          ${escapeHtml(String(day.completedCount))} completed · ${escapeHtml(String(day.missedCount))} missed
        </span>
      </div>
    </summary>
    <div class="table-shell">
      <table class="user-table">
        <thead><tr><th>Employee</th><th>Task</th><th>Status</th></tr></thead>
        <tbody>${rowsMarkup}</tbody>
      </table>
    </div>
  `;
  return card;
}


function renderSidebarVisibility() {
  const usersLink = document.querySelector('.sidebar-link[data-view="users"]');
  if (usersLink) {
    usersLink.classList.toggle("hidden", !canManageUsers(state.activeUser));
  }

  const approvalsLink = document.querySelector('.sidebar-link[data-view="approvals"]');
  if (approvalsLink) {
    approvalsLink.classList.toggle("hidden", !canAssignTasks(state.activeUser));
  }

  const complianceLink = document.querySelector('.sidebar-link[data-view="compliance"]');
  if (complianceLink) {
    complianceLink.classList.toggle("hidden", !canAssignTasks(state.activeUser));
  }
}


function populateFilters() {
  createSelectOptions(elements.roleFilter, getUniqueValues("role"), "All roles", state.role);
  createSelectOptions(
    elements.dayOffFilter,
    getUniqueValues("dayOff").filter((value) => value !== "-"),
    "All days",
    state.dayOff
  );
}


function populateTaskAssigneeOptions() {
  elements.assignTaskUserList.innerHTML = "";
  const users = [...state.users]
    .filter((user) => user.email.toLowerCase() !== state.activeUser?.email?.toLowerCase())
    .sort((left, right) => left.name.localeCompare(right.name));

  users.forEach((user) => {
    const option = document.createElement("option");
    option.value = formatTaskAssigneeOption(user);
    option.label = user.email;
    if (user.email.toLowerCase() === "kamal@modesigns.in") {
      elements.assignTaskUser.value = formatTaskAssigneeOption(user);
    }
    elements.assignTaskUserList.append(option);
  });

  syncTaskAssignmentFields();
}


function populateAbsenceEmployeeOptions() {
  elements.absenceEmployeeList.innerHTML = "";
  getUniqueBuddyEmployees().forEach((employee) => {
    const option = document.createElement("option");
    option.value = employee;
    elements.absenceEmployeeList.append(option);
  });
}


function renderPantryLocationPicker() {
  elements.checklistFields.innerHTML = "";

  const picker = document.createElement("div");
  picker.className = "pantry-location-picker";
  picker.innerHTML = `
    <p class="pantry-location-picker__label">Select the pantry location to upload the checklist for:</p>
    <div class="pantry-location-picker__actions">
      <button type="button" class="button button--ghost" data-pantry-location="MO1">MO1</button>
      <button type="button" class="button button--ghost" data-pantry-location="MO2">MO2</button>
    </div>
  `;
  elements.checklistFields.append(picker);
}


function renderPantryChecklistTable(location) {
  state.pantryFormLocation = location;
  const items = PANTRY_CHECKLISTS[location] || [];
  elements.checklistFields.innerHTML = "";

  const intro = document.createElement("div");
  intro.className = "pantry-location-picker pantry-location-picker--selected";
  intro.innerHTML = `
    <p class="pantry-location-picker__label">Pantry location: <strong>${escapeHtml(location)}</strong></p>
    <button type="button" class="text-button" data-pantry-location-reset="true">Change location</button>
  `;
  elements.checklistFields.append(intro);

  const note = document.createElement("p");
  note.className = "pantry-location-picker__label";
  note.textContent = "Count each item yourself and enter the quantity — nothing is pre-filled.";
  elements.checklistFields.append(note);

  const rowsMarkup = items
    .map((row, index) => {
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(row.item)}</td>
          <td>
            <input
              type="number"
              min="0"
              step="1"
              required
              class="pantry-input pantry-input--quantity"
              data-pantry-item="${escapeHtml(row.item)}"
              data-pantry-expected="${row.quantity}"
              placeholder="Enter count"
            />
          </td>
        </tr>
      `;
    })
    .join("");

  const tableWrap = document.createElement("div");
  tableWrap.className = "pantry-table-wrap";
  tableWrap.innerHTML = `
    <table class="pantry-table">
      <thead>
        <tr>
          <th>S.No.</th>
          <th>Item Name</th>
          <th>Quantity</th>
        </tr>
      </thead>
      <tbody>
        ${rowsMarkup}
      </tbody>
    </table>
  `;
  elements.checklistFields.append(tableWrap);
}


function createRepeatableFollowUpField(question) {
  const entries = [];

  const wrapper = document.createElement("div");
  wrapper.className = "followup-repeat";

  const hiddenInput = document.createElement("input");
  hiddenInput.type = "hidden";
  hiddenInput.id = `question-${question.id}-followup`;
  hiddenInput.name = `${question.id}_followup`;

  const list = document.createElement("ul");
  list.className = "followup-repeat-list";

  const syncHiddenInput = () => {
    hiddenInput.value = entries.join(", ");
  };

  const renderList = () => {
    list.innerHTML = "";
    entries.forEach((entryText, index) => {
      const item = document.createElement("li");
      item.className = "followup-repeat-item";

      const label = document.createElement("span");
      label.textContent = entryText;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "followup-repeat-item__remove";
      removeButton.textContent = "×";
      removeButton.setAttribute("aria-label", "Remove");
      removeButton.addEventListener("click", () => {
        entries.splice(index, 1);
        renderList();
        syncHiddenInput();
      });

      item.append(label, removeButton);
      list.append(item);
    });
  };

  const inputRow = document.createElement("div");
  inputRow.className = "followup-repeat-input-row";

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.placeholder = question.followUpOnNo.placeholder || "Enter details";

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "button button--ghost";
  addButton.textContent = "+ Add";

  const addEntry = () => {
    const value = textInput.value.trim();
    if (!value) {
      return;
    }
    entries.push(value);
    textInput.value = "";
    renderList();
    syncHiddenInput();
    textInput.focus();
  };

  addButton.addEventListener("click", addEntry);
  textInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addEntry();
    }
  });

  inputRow.append(textInput, addButton);
  wrapper.append(inputRow, list, hiddenInput);

  return {
    element: wrapper,
    hiddenInput,
    reset: () => {
      entries.length = 0;
      renderList();
      syncHiddenInput();
      textInput.value = "";
    },
  };
}


function createYesNoCheckboxGroup(question) {
  const container = document.createElement("div");

  const group = document.createElement("div");
  group.className = "checklist-checkbox-group";

  const yesInput = document.createElement("input");
  yesInput.type = "checkbox";
  yesInput.id = `question-${question.id}-yes`;
  yesInput.name = `${question.id}_yes`;

  const noInput = document.createElement("input");
  noInput.type = "checkbox";
  noInput.id = `question-${question.id}-no`;
  noInput.name = `${question.id}_no`;

  if (question.value === "Yes") {
    yesInput.checked = true;
  } else if (question.value === "No") {
    noInput.checked = true;
  }

  let followUpWrapper = null;
  let followUpField = null;
  if (question.followUpOnNo) {
    followUpWrapper = document.createElement("div");
    followUpWrapper.className = "checklist-question__followup hidden";

    const followUpTitle = document.createElement("strong");
    followUpTitle.textContent = question.followUpOnNo.label;
    followUpWrapper.append(followUpTitle);

    if (question.followUpOnNo.type === "repeatable") {
      followUpField = createRepeatableFollowUpField(question);
      followUpWrapper.append(followUpField.element);
    } else {
      const followUpLabel = document.createElement("label");
      followUpLabel.setAttribute("for", `question-${question.id}-followup`);

      const plainField = document.createElement(question.followUpOnNo.type === "textarea" ? "textarea" : "input");
      if (plainField.tagName === "TEXTAREA") {
        plainField.rows = 3;
      } else {
        plainField.type = "text";
      }
      plainField.id = `question-${question.id}-followup`;
      plainField.name = `${question.id}_followup`;

      followUpLabel.append(plainField);
      followUpWrapper.append(followUpLabel);
      followUpField = { hiddenInput: plainField, reset: () => { plainField.value = ""; } };
    }
  }

  const updateFollowUpVisibility = () => {
    if (!followUpWrapper) {
      return;
    }
    const shouldShow = noInput.checked;
    followUpWrapper.classList.toggle("hidden", !shouldShow);
    if (!shouldShow) {
      followUpField.reset();
    }
  };

  yesInput.addEventListener("change", () => {
    if (yesInput.checked) {
      noInput.checked = false;
    }
    updateFollowUpVisibility();
  });
  noInput.addEventListener("change", () => {
    if (noInput.checked) {
      yesInput.checked = false;
    }
    updateFollowUpVisibility();
  });

  const yesRow = document.createElement("label");
  yesRow.className = "checkbox-row";
  yesRow.append(yesInput, document.createTextNode("Yes"));

  const noRow = document.createElement("label");
  noRow.className = "checkbox-row";
  noRow.append(noInput, document.createTextNode("No"));

  group.append(yesRow, noRow);
  container.append(group);

  if (followUpWrapper) {
    container.append(followUpWrapper);
    updateFollowUpVisibility();
  }

  return container;
}


function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

// Native file inputs only show a filename, with no way to drop one file out
// of a multi-file selection — this renders that selection as a removable
// list, rebuilding field.files via DataTransfer since FileList itself is
// read-only.
function attachRemovableFileList(field, wrapper) {
  const list = document.createElement("ul");
  list.className = "checklist-file-list";
  wrapper.append(list);

  const renderList = () => {
    list.innerHTML = "";
    Array.from(field.files || []).forEach((file, index) => {
      const item = document.createElement("li");
      item.className = "checklist-file-list__item";

      const name = document.createElement("span");
      name.textContent = file.name;
      item.append(name);

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "checklist-file-list__remove";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", () => {
        const remaining = Array.from(field.files).filter((_, fileIndex) => fileIndex !== index);
        const dataTransfer = new DataTransfer();
        remaining.forEach((remainingFile) => dataTransfer.items.add(remainingFile));
        field.files = dataTransfer.files;
        renderList();
      });
      item.append(removeButton);

      list.append(item);
    });
  };

  field.addEventListener("change", renderList);
}

// Uploading a file already answers "yes, done" for the paired checkbox
// question — this ticks Yes (and clears No) so the employee doesn't have to
// click both. Manual unchecking afterwards is still respected; this only
// fires on the upload itself.
function attachAutoConfirmOnUpload(fileInput, confirmQuestionId) {
  fileInput.addEventListener("change", () => {
    if (!fileInput.files || !fileInput.files.length) {
      return;
    }
    const yesInput = document.getElementById(`question-${confirmQuestionId}-yes`);
    if (yesInput && !yesInput.checked) {
      yesInput.checked = true;
      yesInput.dispatchEvent(new Event("change"));
    }
  });
}

function attachOcrAutofill(fileInput, numberField, wrapper, unitHint) {
  const status = document.createElement("p");
  status.className = "checklist-hint checklist-ocr-status hidden";
  wrapper.append(status);

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      status.classList.add("hidden");
      return;
    }

    status.classList.remove("hidden");
    status.textContent = "Reading the number from the photo (via local Ollama)…";

    try {
      const imageBase64 = await readFileAsBase64(file);
      const response = await fetch(buildApiUrl("/api/ocr-read-number"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ imageBase64, unitHint }),
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        status.textContent = result.error || "Couldn't read the photo automatically — enter the reading manually.";
        return;
      }

      if (result.reading) {
        numberField.value = result.reading;
        numberField.dispatchEvent(new Event("input", { bubbles: true }));
        status.textContent = `Auto-filled "${result.reading}" from the photo — please confirm it's correct. (Model said: "${result.rawText}")`;
      } else {
        status.textContent = `Couldn't find a number in the photo — enter it manually. (Model said: "${result.rawText}")`;
      }
    } catch (error) {
      status.textContent = "Couldn't reach the local OCR service — enter the reading manually.";
    }
  });
}


function renderChecklistFields(template) {
  elements.checklistFields.innerHTML = "";
  let previousNumberQuestion = null;
  template.questions.forEach((question) => {
    const wrapper = document.createElement("div");
    wrapper.className = "checklist-question";

    const label = document.createElement("label");
    label.setAttribute("for", `question-${question.id}`);

    const title = document.createElement("strong");
    title.textContent = question.label;
    label.append(title);

    if (question.labelHindi) {
      const titleHindi = document.createElement("span");
      titleHindi.className = "checklist-question__hindi";
      titleHindi.textContent = question.labelHindi;
      label.append(titleHindi);
    }

    wrapper.append(label);

    if (question.type === "checkbox") {
      label.removeAttribute("for");
      wrapper.append(createYesNoCheckboxGroup(question));
      previousNumberQuestion = null;

      if (question.hint) {
        const hint = document.createElement("p");
        hint.className = "checklist-hint";
        hint.textContent = question.hint;
        wrapper.append(hint);
      }
      elements.checklistFields.append(wrapper);
      return;
    }

    let field;
    if (question.type === "textarea") {
      field = document.createElement("textarea");
      field.rows = 4;
    } else if (question.type === "select") {
      field = document.createElement("select");
      (question.options || []).forEach((optionValue) => {
        const option = document.createElement("option");
        option.value = optionValue;
        option.textContent = optionValue;
        field.append(option);
      });
    } else {
      field = document.createElement("input");
      field.type = question.type === "file" || question.type === "photo" ? "file" : question.type;
      if (question.type === "file") {
        field.multiple = true;
        field.accept = "image/*,.pdf,.doc,.docx,.xlsx,.csv";
      }
      if (question.type === "photo") {
        field.accept = "image/*";
        field.setAttribute("capture", "environment");
        field.multiple = true;
      }
    }

    if ((question.type === "file" || question.type === "photo") && previousNumberQuestion) {
      attachOcrAutofill(field, previousNumberQuestion.field, wrapper, previousNumberQuestion.question.ocrUnitHint);
    }
    if ((question.type === "file" || question.type === "photo") && question.autoConfirmQuestionId) {
      attachAutoConfirmOnUpload(field, question.autoConfirmQuestionId);
    }
    if (question.type === "file" || question.type === "photo") {
      attachRemovableFileList(field, wrapper);
    }
    previousNumberQuestion = question.type === "number" ? { field, question } : null;

    field.id = `question-${question.id}`;
    field.name = question.id;
    field.required = question.type !== "file" && question.type !== "photo";
    field.readOnly = Boolean(question.readOnly);

    if (question.placeholder && "placeholder" in field) {
      field.placeholder = question.placeholder;
    }

    if (question.defaultValue === "today" && question.type === "date") {
      field.value = todayValue();
    }

    if (question.defaultValue === "now" && question.type === "datetime-local") {
      const now = new Date();
      const localDateTime = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
      field.value = localDateTime;
    }

    if (question.defaultValue === "timestamp_now") {
      const now = new Date();
      const day = String(now.getDate()).padStart(2, "0");
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const year = now.getFullYear();
      let hours = now.getHours();
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const meridiem = hours >= 12 ? "PM" : "AM";
      hours = hours % 12 || 12;
      field.value = `${day}-${month}-${year} ${hours}:${minutes} ${meridiem}`;
    }

    if (question.value != null && question.type !== "file" && question.type !== "photo") {
      field.value = question.value;
    }

    label.append(field);

    if (question.hint) {
      const hint = document.createElement("p");
      hint.className = "checklist-hint";
      hint.textContent = question.hint;
      wrapper.append(hint);
    }

    elements.checklistFields.append(wrapper);
  });
}

function renderGeneratorPicker(task) {
  destroyChecklistMap();
  state.activeGeneratorUnit = null;
  elements.checklistFields.innerHTML = "";
  elements.checklistSubmitRow.classList.add("hidden");

  const intro = document.createElement("p");
  intro.className = "pantry-location-picker__label";
  intro.textContent = "Select the generator name to fill its checklist:";
  elements.checklistFields.append(intro);

  const list = document.createElement("div");
  list.className = "visit-list";

  GENERATOR_CHECKLIST_UNITS.forEach((generatorUnit) => {
    const isDone = Boolean(state.completions[getGeneratorCompletionKey(task, generatorUnit)]);
    const row = document.createElement("div");
    row.className = "visit-row" + (isDone ? " is-done" : "");

    if (isDone) {
      row.innerHTML = `
        <span class="visit-row__label">${escapeHtml(generatorUnit)}</span>
        <span class="status-badge">Submitted ✓</span>
      `;
    } else {
      row.innerHTML = `
        <span class="visit-row__label">${escapeHtml(generatorUnit)}</span>
        <button type="button" class="button button--ghost" data-generator-open="${escapeHtml(generatorUnit)}">Open checklist</button>
      `;
    }

    list.append(row);
  });

  elements.checklistFields.append(list);
}

function renderGeneratorChecklist(task, generatorUnit) {
  state.activeGeneratorUnit = generatorUnit;
  renderChecklistFields(buildGeneratorChecklistTemplate(generatorUnit));
  elements.checklistSubmitRow.classList.remove("hidden");

  const selectedNote = document.createElement("p");
  selectedNote.className = "pantry-location-picker__label";
  selectedNote.textContent = `Selected generator: ${generatorUnit}`;
  elements.checklistFields.prepend(selectedNote);

  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "text-button";
  backButton.setAttribute("data-generator-reset", "true");
  backButton.textContent = "Back to generator list";
  elements.checklistFields.prepend(backButton);
}


function renderCashHandlingPicker(task) {
  destroyChecklistMap();
  state.activeCashHandlingShift = null;
  elements.checklistFields.innerHTML = "";
  elements.checklistSubmitRow.classList.add("hidden");

  const intro = document.createElement("p");
  intro.className = "pantry-location-picker__label";
  intro.textContent = "Select the shift to fill its cash handling checklist:";
  elements.checklistFields.append(intro);

  const list = document.createElement("div");
  list.className = "visit-list";

  CASH_HANDLING_SHIFTS.forEach((shift) => {
    const isDone = Boolean(state.completions[getCashHandlingCompletionKey(task, shift)]);
    const row = document.createElement("div");
    row.className = "visit-row" + (isDone ? " is-done" : "");

    if (isDone) {
      row.innerHTML = `
        <span class="visit-row__label">${escapeHtml(shift)}</span>
        <span class="status-badge">Submitted ✓</span>
      `;
    } else {
      row.innerHTML = `
        <span class="visit-row__label">${escapeHtml(shift)}</span>
        <button type="button" class="button button--ghost" data-cash-shift-open="${escapeHtml(shift)}">Open checklist</button>
      `;
    }

    list.append(row);
  });

  elements.checklistFields.append(list);
}

function renderCashHandlingChecklist(task, shift) {
  state.activeCashHandlingShift = shift;
  renderChecklistFields(buildCashHandlingChecklistTemplate(shift));
  elements.checklistSubmitRow.classList.remove("hidden");

  const notesWrapper = document.querySelector("#question-cash_handling_notes")?.closest(".checklist-question");
  if (notesWrapper) {
    notesWrapper.before(createCashDenominationTable());
  }

  const selectedNote = document.createElement("p");
  selectedNote.className = "pantry-location-picker__label";
  selectedNote.textContent = `Selected shift: ${shift}`;
  elements.checklistFields.prepend(selectedNote);

  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "text-button";
  backButton.setAttribute("data-cash-shift-reset", "true");
  backButton.textContent = "Back to shift list";
  elements.checklistFields.prepend(backButton);
}


function createCashDenominationTable() {
  const wrapper = document.createElement("div");
  wrapper.className = "checklist-question";

  const label = document.createElement("strong");
  label.textContent = "Enter the cash in the locker";
  wrapper.append(label);

  const hint = document.createElement("p");
  hint.className = "checklist-hint";
  hint.textContent = "Count each denomination and the loose change yourself — the amount is calculated automatically.";
  wrapper.append(hint);

  const noteRowsMarkup = CASH_DENOMINATIONS.map((denomination) => {
    return `
      <tr>
        <td>₹${denomination}</td>
        <td>
          <input
            type="number"
            min="0"
            step="1"
            class="pantry-input cash-denom-input"
            data-cash-denom="${denomination}"
            placeholder="Notes"
          />
        </td>
        <td class="cash-denom-amount" data-cash-denom-amount="${denomination}">₹0</td>
      </tr>
    `;
  }).join("");

  const coinsRowMarkup = `
    <tr>
      <td>Coins / Change</td>
      <td colspan="2">
        <input
          type="number"
          min="0"
          step="1"
          class="pantry-input cash-coins-input"
          placeholder="Enter amount"
        />
      </td>
    </tr>
  `;

  const tableWrap = document.createElement("div");
  tableWrap.className = "cash-table-wrap";
  tableWrap.innerHTML = `
    <table class="pantry-table">
      <thead>
        <tr>
          <th>Denomination</th>
          <th>Notes</th>
          <th>Amount</th>
        </tr>
      </thead>
      <tbody>
        ${noteRowsMarkup}
        ${coinsRowMarkup}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="2"><strong>Total</strong></td>
          <td class="cash-denom-total"><strong>₹0</strong></td>
        </tr>
      </tfoot>
    </table>
  `;
  wrapper.append(tableWrap);

  tableWrap.querySelectorAll(".cash-denom-input, .cash-coins-input").forEach((input) => {
    input.addEventListener("input", () => updateCashDenominationTotals(tableWrap));
  });

  return wrapper;
}


function updateCashDenominationTotals(tableWrap) {
  let total = 0;
  tableWrap.querySelectorAll(".cash-denom-input").forEach((input) => {
    const denomination = Number(input.getAttribute("data-cash-denom"));
    const notes = Number(input.value) || 0;
    const amount = denomination * notes;
    total += amount;
    const amountCell = tableWrap.querySelector(`[data-cash-denom-amount="${denomination}"]`);
    if (amountCell) {
      amountCell.textContent = `₹${amount}`;
    }
  });

  const coinsInput = tableWrap.querySelector(".cash-coins-input");
  total += Number(coinsInput?.value) || 0;

  const totalCell = tableWrap.querySelector(".cash-denom-total");
  if (totalCell) {
    totalCell.innerHTML = `<strong>₹${total}</strong>`;
  }
}


function renderMeterReadingPicker(task) {
  destroyChecklistMap();
  state.activeMeterReadingLocation = null;
  elements.checklistFields.innerHTML = "";
  elements.checklistSubmitRow.classList.add("hidden");

  const intro = document.createElement("p");
  intro.className = "pantry-location-picker__label";
  intro.textContent = "Select the location to fill its meter reading checklist:";
  elements.checklistFields.append(intro);

  const list = document.createElement("div");
  list.className = "visit-list";

  METER_READING_LOCATIONS.forEach((location) => {
    const isDone = Boolean(state.completions[getMeterReadingCompletionKey(task, location)]);
    const row = document.createElement("div");
    row.className = "visit-row" + (isDone ? " is-done" : "");

    if (isDone) {
      row.innerHTML = `
        <span class="visit-row__label">${escapeHtml(location)}</span>
        <span class="status-badge">Submitted ✓</span>
      `;
    } else {
      row.innerHTML = `
        <span class="visit-row__label">${escapeHtml(location)}</span>
        <button type="button" class="button button--ghost" data-meter-location-open="${escapeHtml(location)}">Open checklist</button>
      `;
    }

    list.append(row);
  });

  elements.checklistFields.append(list);
}

function renderMeterReadingChecklist(task, location) {
  state.activeMeterReadingLocation = location;
  renderChecklistFields(buildMeterReadingChecklistTemplate(location));
  elements.checklistSubmitRow.classList.remove("hidden");

  const selectedNote = document.createElement("p");
  selectedNote.className = "pantry-location-picker__label";
  selectedNote.textContent = `Selected location: ${location}`;
  elements.checklistFields.prepend(selectedNote);

  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "text-button";
  backButton.setAttribute("data-meter-location-reset", "true");
  backButton.textContent = "Back to location list";
  elements.checklistFields.prepend(backButton);
}


function renderEarthingCleaningPicker(task) {
  destroyChecklistMap();
  state.activeEarthingCleaningLocation = null;
  elements.checklistFields.innerHTML = "";
  elements.checklistSubmitRow.classList.add("hidden");

  const intro = document.createElement("p");
  intro.className = "pantry-location-picker__label";
  intro.textContent = "Select the location to fill its earthing and cleaning checklist:";
  elements.checklistFields.append(intro);

  const list = document.createElement("div");
  list.className = "visit-list";

  EARTHING_CLEANING_LOCATIONS.forEach((location) => {
    const isDone = Boolean(state.completions[getEarthingCleaningCompletionKey(task, location)]);
    const row = document.createElement("div");
    row.className = "visit-row" + (isDone ? " is-done" : "");

    if (isDone) {
      row.innerHTML = `
        <span class="visit-row__label">${escapeHtml(location)}</span>
        <span class="status-badge">Submitted ✓</span>
      `;
    } else {
      row.innerHTML = `
        <span class="visit-row__label">${escapeHtml(location)}</span>
        <button type="button" class="button button--ghost" data-earthing-location-open="${escapeHtml(location)}">Open checklist</button>
      `;
    }

    list.append(row);
  });

  elements.checklistFields.append(list);
}

function renderEarthingCleaningChecklist(task, location) {
  state.activeEarthingCleaningLocation = location;
  renderChecklistFields(buildEarthingCleaningChecklistTemplate(location));
  elements.checklistSubmitRow.classList.remove("hidden");

  const selectedNote = document.createElement("p");
  selectedNote.className = "pantry-location-picker__label";
  selectedNote.textContent = `Selected location: ${location}`;
  elements.checklistFields.prepend(selectedNote);

  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "text-button";
  backButton.setAttribute("data-earthing-location-reset", "true");
  backButton.textContent = "Back to location list";
  elements.checklistFields.prepend(backButton);
}


function renderVisitPicker(task) {
  destroyChecklistMap();
  elements.checklistFields.innerHTML = "";
  elements.checklistSubmitRow.classList.add("hidden");

  elements.checklistFields.append(createVisitLocationControl());
  initChecklistLocationMap();

  const intro = document.createElement("p");
  intro.className = "pantry-location-picker__label";
  intro.textContent = "Open the site visit form for each visit, fill it in there, then tick it off here once submitted:";
  elements.checklistFields.append(intro);

  const list = document.createElement("div");
  list.className = "visit-list";

  for (let visitNumber = 1; visitNumber <= SITE_VISIT_COUNT; visitNumber++) {
    const isDone = Boolean(state.completions[getVisitCompletionKey(task, visitNumber)]);
    const row = document.createElement("div");
    row.className = "visit-row" + (isDone ? " is-done" : "");

    if (isDone) {
      row.innerHTML = `
        <span class="visit-row__label">Visit ${visitNumber}</span>
        <span class="status-badge">Submitted ✓</span>
      `;
    } else {
      row.innerHTML = `
        <span class="visit-row__label">Visit ${visitNumber}</span>
        <button type="button" class="button button--ghost" data-visit-open="${visitNumber}">Open form ↗</button>
        <label class="visit-row__confirm">
          <input type="checkbox" data-visit-confirm="${visitNumber}" />
          Mark submitted
        </label>
      `;
    }
    list.append(row);
  }

  elements.checklistFields.append(list);
}


function createVisitLocationControl() {
  const isSharing = Boolean(state.myLocationExpiresAt) && Date.now() < state.myLocationExpiresAt;
  const wrap = document.createElement("div");
  wrap.id = "visitLocationControl";
  wrap.className = "pantry-location-picker";

  if (isSharing) {
    const expiresLabel = new Date(state.myLocationExpiresAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    wrap.innerHTML = `
      <p class="pantry-location-picker__label">📍 Sharing your live location — until <strong>${expiresLabel}</strong></p>
      <div class="pantry-location-picker__actions">
        <button type="button" class="text-button" data-stop-sharing="true">Stop sharing</button>
      </div>
      <div class="visit-location-map"></div>
    `;
  } else {
    wrap.innerHTML = `
      <p class="pantry-location-picker__label">Share your live location while you visit these sites:</p>
      <div class="pantry-location-picker__actions">
        <button type="button" class="button button--ghost" data-share-duration="15">Share for 15 min</button>
        <button type="button" class="button button--ghost" data-share-duration="60">Share for 1 hour</button>
        <button type="button" class="button button--ghost" data-share-duration="180">Share for 3 hours</button>
      </div>
    `;
  }

  return wrap;
}


function initChecklistLocationMap() {
  const mapContainer = document.querySelector("#visitLocationControl .visit-location-map");
  const share = state.liveLocations[state.activeUser?.email];
  if (!mapContainer || !share || typeof L === "undefined") {
    return;
  }

  state.checklistMapInstance = L.map(mapContainer).setView([share.lat, share.lng], 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(state.checklistMapInstance);
  state.checklistMapMarker = L.marker([share.lat, share.lng]).addTo(state.checklistMapInstance);
  setTimeout(() => state.checklistMapInstance && state.checklistMapInstance.invalidateSize(), 50);
}


function destroyChecklistMap() {
  if (state.checklistMapInstance) {
    state.checklistMapInstance.remove();
    state.checklistMapInstance = null;
    state.checklistMapMarker = null;
  }
}


function refreshChecklistMapPosition() {
  const share = state.liveLocations[state.activeUser?.email];
  if (!state.checklistMapInstance || !state.checklistMapMarker || !share) {
    return;
  }
  const latLng = [share.lat, share.lng];
  state.checklistMapMarker.setLatLng(latLng);
  state.checklistMapInstance.setView(latLng);
}


// Swaps just the location-sharing block in place (start/stop toggles),
// instead of re-rendering the whole visit form — so any answers already
// typed into the other fields aren't wiped out.
function refreshLocationControlInPlace() {
  const existing = document.getElementById("visitLocationControl");
  if (!existing) {
    return;
  }
  destroyChecklistMap();
  existing.replaceWith(createVisitLocationControl());
  initChecklistLocationMap();
}


function renderLiveShareBanner() {
  const isSharing = Boolean(state.myLocationExpiresAt) && Date.now() < state.myLocationExpiresAt;
  if (!isSharing) {
    elements.liveShareBanner.classList.add("hidden");
    elements.liveShareBanner.innerHTML = "";
    return;
  }

  const expiresLabel = new Date(state.myLocationExpiresAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  elements.liveShareBanner.classList.remove("hidden");
  elements.liveShareBanner.innerHTML = `
    <span>📍 Sharing your live location${state.myLocationTask?.title ? ` for "${escapeHtml(state.myLocationTask.title)}"` : ""} — until ${expiresLabel}</span>
    <button type="button" class="text-button" data-stop-sharing="true">Stop sharing</button>
  `;
}




function toggleViews(isLoggedIn) {
  elements.authView.classList.toggle("hidden", isLoggedIn);
  elements.dashboardView.classList.toggle("hidden", !isLoggedIn);
}


function renderCurrentView() {
  const isHomeView = state.currentView === "home";
  const isUsersView = state.currentView === "users";
  const isApprovalsView = state.currentView === "approvals";
  const isComplianceView = state.currentView === "compliance";
  const isBuddyView = state.currentView === "buddy";
  const isContactsView = state.currentView === "contacts";

  elements.homePage.classList.toggle("hidden", !isHomeView);
  elements.usersPage.classList.toggle("hidden", !isUsersView);
  elements.approvalsPage.classList.toggle("hidden", !isApprovalsView);
  elements.compliancePage.classList.toggle("hidden", !isComplianceView);
  elements.buddyPage.classList.toggle("hidden", !isBuddyView);
  elements.contactsPage.classList.toggle("hidden", !isContactsView);

  elements.navLinks.forEach((link) => {
    link.classList.toggle("is-active", link.dataset.view === state.currentView);
  });
}


function renderSidebarState() {
  elements.dashboardView.classList.toggle("sidebar-collapsed", state.isSidebarCollapsed);
}


function createTableRow(user) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td class="name-cell">
      <strong>${escapeHtml(user.name)}</strong>
      <span>${escapeHtml(user.email)}</span>
    </td>
    <td>${escapeHtml(user.email)}</td>
    <td><span class="role-pill">${escapeHtml(user.role)}</span></td>
    <td>${escapeHtml(normalizeValue(user.designation))}</td>
    <td>${escapeHtml(normalizeValue(user.code))}</td>
    <td><span class="day-pill">${escapeHtml(normalizeValue(user.dayOff))}</span></td>
  `;
  return row;
}


function createMobileCard(user) {
  const card = document.createElement("article");
  card.className = "mobile-card";
  card.innerHTML = `
    <strong>${escapeHtml(user.name)}</strong>
    <div class="mobile-card__meta">${escapeHtml(user.email)}</div>
    <div class="mobile-card__meta">Role: ${escapeHtml(user.role)}</div>
    <div class="mobile-card__meta">Designation: ${escapeHtml(normalizeValue(user.designation))}</div>
    <div class="mobile-card__meta">Salesman Code: ${escapeHtml(normalizeValue(user.code))}</div>
    <div class="mobile-card__meta">Day Off: ${escapeHtml(normalizeValue(user.dayOff))}</div>
  `;
  return card;
}


function createAdminTaskCard(group) {
  const card = document.createElement("details");
  card.className = "task-card task-card--admin task-card--group";

  const tasksMarkup = group.tasks
    .map((task) => {
      return `
        <article class="admin-task-item">
          <div class="admin-task-item__top">
            <strong>${escapeHtml(task.title)}</strong>
            <div class="admin-task-item__actions">
              <span class="task-badge">${escapeHtml(getFrequencyLabel(getTaskDisplayFrequency(task)))}</span>
              <button type="button" class="edit-task-button" data-edit-task="${escapeHtml(task.id)}">Edit task</button>
              ${
                canAssignTasks(state.activeUser)
                  ? `<button type="button" class="edit-task-button edit-task-button--danger" data-delete-task="${escapeHtml(task.id)}">Delete task</button>`
                  : ""
              }
            </div>
          </div>
          <div class="task-card__meta">
            <span>Task ID ${escapeHtml(task.taskId || task.id)}</span>
            <span>Starts ${escapeHtml(formatDateValue(task.plannedDate))}</span>
            <span>Active until ${escapeHtml(formatDateValue(task.validUntil))}</span>
          </div>
          <p class="task-card__details">${escapeHtml(task.details)}</p>
        </article>
      `;
    })
    .join("");

  card.innerHTML = `
    <summary class="admin-task-summary">
      <div class="task-card__top">
        <div>
          <strong>${escapeHtml(group.assigneeName)}</strong>
          <div class="task-card__meta">
            <span>${group.tasks.length} task${group.tasks.length === 1 ? "" : "s"}</span>
            <span>Department ${escapeHtml(normalizeValue(group.department))}</span>
          </div>
        </div>
        <span class="task-badge">${escapeHtml(group.tasks.length === 1 ? "1 Task" : `${group.tasks.length} Tasks`)}</span>
      </div>
      <div class="task-card__grid">
        <div class="task-kpi">
          <span>Name</span>
          <strong>${escapeHtml(group.assigneeName)}</strong>
        </div>
        <div class="task-kpi">
          <span>Department</span>
          <strong>${escapeHtml(normalizeValue(group.department))}</strong>
        </div>
        <div class="task-kpi">
          <span>Starts</span>
          <strong>${escapeHtml(formatDateValue(group.starts))}</strong>
        </div>
        <div class="task-kpi">
          <span>Active until</span>
          <strong>${escapeHtml(formatDateValue(group.activeUntil))}</strong>
        </div>
      </div>
    </summary>
    <div class="admin-task-list">
      ${tasksMarkup}
    </div>
  `;
  return card;
}


function createCompletionStatusBadge(completion) {
  if (completion.status === "not_completed") {
    return `<span class="status-badge status-badge--alert" title="${escapeHtml(completion.remarks || "")}">Not completed</span>`;
  }
  return `<span class="status-badge">Completed</span>`;
}


// Only for single-shot tasks — the multi-entry types (site visits, generator
// units, cash-handling shifts, etc.) keep their own progress button below
// since "completed/not completed" doesn't fit a checklist with several
// independently-completable rows inside it.
function createTaskStatusSelect(task, availability) {
  if (!availability.enabled) {
    return `<button type="button" class="status-button" disabled title="${escapeHtml(availability.reason)}">${escapeHtml(availability.label)}</button>`;
  }
  const taskKey = escapeHtml(getTaskOccurrenceIdentity(task));
  return `
    <select class="status-select" data-status-select="true" data-task-key="${taskKey}">
      <option value="" selected disabled hidden>Update status</option>
      <option value="completed">Task completed</option>
      <option value="not_completed">Not completed</option>
    </select>
  `;
}


function createEmployeeTaskRow(task) {
  const completion = getCompletionRecord(task);
  const availability = getTaskAvailability(task);
  const row = document.createElement("tr");

  const isMultiStepTask =
    isSiteVisitTask(task) ||
    isGeneratorChecklistTask(task) ||
    isCashHandlingChecklistTask(task) ||
    isMeterReadingChecklistTask(task) ||
    isEarthingCleaningTask(task);

  let buttonLabel = availability.label;
  if (!completion && isSiteVisitTask(task)) {
    const doneCount = Array.from({ length: SITE_VISIT_COUNT }, (_, index) => index + 1).filter((number) =>
      Boolean(state.completions[getVisitCompletionKey(task, number)])
    ).length;
    buttonLabel = `Visits (${doneCount}/${SITE_VISIT_COUNT})`;
  } else if (!completion && isGeneratorChecklistTask(task)) {
    const doneCount = GENERATOR_CHECKLIST_UNITS.filter((unit) =>
      Boolean(state.completions[getGeneratorCompletionKey(task, unit)])
    ).length;
    buttonLabel = `Generators (${doneCount}/${GENERATOR_CHECKLIST_UNITS.length})`;
  } else if (!completion && isCashHandlingChecklistTask(task)) {
    const doneCount = CASH_HANDLING_SHIFTS.filter((shift) =>
      Boolean(state.completions[getCashHandlingCompletionKey(task, shift)])
    ).length;
    buttonLabel = `Shifts (${doneCount}/${CASH_HANDLING_SHIFTS.length})`;
  } else if (!completion && isMeterReadingChecklistTask(task)) {
    const doneCount = METER_READING_LOCATIONS.filter((location) =>
      Boolean(state.completions[getMeterReadingCompletionKey(task, location)])
    ).length;
    buttonLabel = `Locations (${doneCount}/${METER_READING_LOCATIONS.length})`;
  } else if (!completion && isEarthingCleaningTask(task)) {
    const doneCount = EARTHING_CLEANING_LOCATIONS.filter((location) =>
      Boolean(state.completions[getEarthingCleaningCompletionKey(task, location)])
    ).length;
    buttonLabel = `Locations (${doneCount}/${EARTHING_CLEANING_LOCATIONS.length})`;
  }

  const isFuelRequest = isFuelRequestTask(task);
  const fuelApproved = isFuelRequest && completion?.fuelRequestApprovalStatus === "approved";
  const displayTitle = fuelApproved ? "Fuel checklist" : getTaskDisplayTitle(task);

  let actionCell;
  if (isFuelRequest) {
    if (!completion) {
      actionCell = `<button type="button" class="status-button" data-request-fuel-task="true" data-task-key="${escapeHtml(getTaskOccurrenceIdentity(task))}">Request</button>`;
    } else if (fuelApproved) {
      actionCell = createCompletionStatusBadge(completion);
    } else {
      actionCell = `<span class="status-badge status-badge--pending">Awaiting approval</span>`;
    }
  } else if (completion) {
    actionCell = createCompletionStatusBadge(completion);
  } else if (isMultiStepTask) {
    actionCell = availability.enabled
      ? `<button type="button" class="status-button" data-complete-task="true" data-task-key="${escapeHtml(getTaskOccurrenceIdentity(task))}">${escapeHtml(buttonLabel)}</button>`
      : `<button type="button" class="status-button" disabled title="${escapeHtml(availability.reason)}">${escapeHtml(buttonLabel)}</button>`;
  } else {
    actionCell = createTaskStatusSelect(task, availability);
  }

  row.innerHTML = `
    <td>${escapeHtml(task.coverageSourceName || task.assigneeName || state.activeUser?.name || "-")}</td>
    <td>${escapeHtml(displayTitle)}</td>
    <td>${escapeHtml(task.customerAttributionName || task.customerName || "-")}</td>
    <td>${escapeHtml(task.customerAttributionKey || task.walkinId || "-")}</td>
    <td><span class="freq-pill">${escapeHtml(getFrequencyShortLabel(getTaskDisplayFrequency(task)))}</span></td>
    <td>${escapeHtml(formatTaskDate(task))}</td>
    <td>${actionCell}</td>
  `;
  return row;
}


function createEmptyState(text) {
  const item = document.createElement("div");
  item.className = "task-empty";
  item.textContent = text;
  return item;
}


function createCoverageCard(item) {
  const card = document.createElement("article");
  card.className = "mobile-card";
  card.innerHTML = `
    <strong>${escapeHtml(item.employee)}</strong>
    <div class="mobile-card__meta">Reason: ${escapeHtml(item.type)}${item.source === "sheet" ? " (from Leave sheet)" : ""}</div>
    <div class="mobile-card__meta">Date: ${escapeHtml(formatDateValue(item.date))}</div>
    <div class="mobile-card__meta">Buddy: ${escapeHtml(item.buddies.join(", ") || "-")}</div>
    <div class="mobile-card__meta">Department: ${escapeHtml(item.department || "-")}</div>
    ${
      item.source === "manual" && canManageUsers(state.activeUser)
        ? `<div class="task-card__actions"><button type="button" class="status-button" data-clear-absence="true" data-employee="${escapeHtml(item.employee)}" data-date="${escapeHtml(item.date)}">Clear absence</button></div>`
        : ""
    }
  `;
  return card;
}


function createSelectOptions(select, values, defaultLabel, currentValue) {
  select.innerHTML = "";
  select.append(createOption("all", defaultLabel));
  values.forEach((value) => {
    select.append(createOption(value, value));
  });
  select.value = values.includes(currentValue) || currentValue === "all" ? currentValue : "all";
}


function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}
