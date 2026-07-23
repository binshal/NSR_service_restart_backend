const express = require("express");
const router = express.Router();

// GET /AIMWebService/api/Accounts?AppID=...&Safe=...&Object=...
// Mocks CyberArk's Central Credential Provider (CCP) REST API response shape,
// so restart_nsr_windows / restart_nsr_aix can call this exactly the way they'd
// call real CyberArk in production (same query params, same response fields).
router.get("/Accounts", (req, res) => {
  const { AppID, Safe, Object: objectName } = req.query;

  if (!AppID || !Safe || !objectName) {
    return res.status(400).json({
      ErrorCode: "APPAP227E",
      ErrorMsg: "AppID, Safe, and Object are required query parameters",
    });
  }

  // Real CyberArk returns 404-shaped errors when no matching account exists in the Safe.
  // For the demo we always resolve successfully so the flow can be exercised end-to-end.
  const serverName = objectName.replace(/-Admin$/i, "");

  res.json({
    Content: "MockPassword123!",
    UserName: "demo_nsr_admin",
    Address: serverName,
    Safe,
    AppID,
    PasswordChangeInProcess: false,
  });
});

module.exports = router;
