// Replace the contents of your "BuddyData" file with this. The buddy
// roster itself now lives on the server (server.js) and is fetched fresh
// each time via the sheets-feed — so editing it there updates this app
// automatically, no redeployment needed. This file only keeps the pure
// matching logic.

function normalizePersonName_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getDayNameFromDate_(dateStr) {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days[new Date(dateStr + "T00:00:00").getDay()];
}

// buddyAssignments is fetched from the server on each call (see
// getDashboardData in webapp.gs), not hardcoded here.
function getCoverageBannerForUser_(user, todayStr, buddyAssignments) {
  const todayName = getDayNameFromDate_(todayStr);
  const userKey = normalizePersonName_(user.name);
  const assignments = buddyAssignments || [];

  for (let i = 0; i < assignments.length; i++) {
    const entry = assignments[i];
    if (String(entry.weekOff || "").toLowerCase() !== todayName.toLowerCase()) {
      continue;
    }
    for (let j = 0; j < entry.buddies.length; j++) {
      const buddyKey = normalizePersonName_(entry.buddies[j]);
      if (buddyKey === userKey) {
        return "It's " + entry.employee + "'s week off today — you're covering their tasks.";
      }
    }
  }

  // Fuzzy fallback pass, only for buddy references with no exact match
  // anywhere in the roster (avoids confusing two people who share a first
  // name, e.g. "Sanjay" vs "Sanjay Yadav").
  for (let i = 0; i < assignments.length; i++) {
    const entry = assignments[i];
    if (String(entry.weekOff || "").toLowerCase() !== todayName.toLowerCase()) {
      continue;
    }
    for (let j = 0; j < entry.buddies.length; j++) {
      const buddyKey = normalizePersonName_(entry.buddies[j]);
      const hasExactOwner = assignments.some(function (e) {
        return normalizePersonName_(e.employee) === buddyKey;
      });
      if (hasExactOwner) {
        continue;
      }
      if (buddyKey.indexOf(userKey) !== -1 || userKey.indexOf(buddyKey) !== -1) {
        return "It's " + entry.employee + "'s week off today — you're covering their tasks.";
      }
    }
  }

  return null;
}

// Returns everyone whose week off is today, for the Buddy Coverage page.
function getTodayCoverageList_(todayStr, buddyAssignments) {
  const todayName = getDayNameFromDate_(todayStr).toLowerCase();
  return (buddyAssignments || []).filter(function (entry) {
    return String(entry.weekOff || "").toLowerCase() === todayName;
  });
}
