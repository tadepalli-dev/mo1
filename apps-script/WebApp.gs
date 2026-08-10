// Replace the ENTIRE contents of "webapp.gs" with this. This is now the
// whole file — everything else that used to be here (verifyLogin,
// getDashboardData, assignTask, etc.) is gone, because this app no longer
// keeps its own copy of the MoTrack UI. It just sends visitors straight to
// the real, running MoTrack app. Whatever you build in MO1 (a new
// dropdown, a new page, anything) shows up here automatically, the next
// time anyone opens this link — because they're not looking at a copy,
// they're looking at the real app.
//
// Reuses MOTRACK_URL declared in Code.gs. Set that constant to the stable
// Vercel URL so this redirect does not break whenever a temporary tunnel
// goes offline.

function doGet(e) {
  const targetUrl = MOTRACK_URL;
  const html =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"refresh\" content=\"0;url=" + targetUrl + "\">" +
    "<title>Redirecting to MoTrack</title></head>" +
    "<body style=\"font-family:sans-serif;text-align:center;padding-top:4rem;color:#152126;\">" +
    "<p>Redirecting to MoTrack…</p>" +
    "<p>If nothing happens, <a href=\"" + targetUrl + "\" target=\"_top\">click here</a>.</p>" +
    "<script>window.top.location.href = " + JSON.stringify(targetUrl) + ";</script>" +
    "</body></html>";
  return HtmlService.createHtmlOutput(html);
}
