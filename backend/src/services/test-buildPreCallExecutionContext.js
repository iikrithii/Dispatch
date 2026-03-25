const fs = require("fs");
const path = require("path");

// load local.settings.json into process.env
const settingsPath = path.resolve(__dirname, "../../local.settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
Object.assign(process.env, settings.Values);

const { buildPreCallExecutionContext } = require("./jiraService.js");

async function run() {
  const input = {
    userEmail: process.env.JIRA_EMAIL,
    event: {
      subject: "Landing page refresh and testimonial launch",
    },
    pastMeeting: {
      subject: "Landing page launch review",
    },
    emails: [
      {
        subject: "Need testimonial approval before launch",
        bodyPreview: "Can we confirm testimonial legal sign-off?",
      },
    ],
  };

  const result = await buildPreCallExecutionContext(input);
  console.log(JSON.stringify(result, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});