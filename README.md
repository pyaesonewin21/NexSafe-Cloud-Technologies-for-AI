# NexSafe — Smart Issue Reporting Platform

**A cloud-based campus safety and maintenance reporting application with AI-assisted photo verification.**

NexSafe gives students a structured way to report hazards and facility issues, while staff can review, prioritise, update, and resolve submissions. It was developed as a **Cloud Technologies for AI** academic project.

## Project overview

Campus problems such as damaged furniture, exposed wiring, water leaks, and blocked staircases can go unreported or be difficult to track. NexSafe connects students and facilities staff through a central reporting workflow, with photo evidence and status tracking.

**Original deployed demo:** [NexSafe on Amazon CloudFront](https://d2a0yi8f3vpirh.cloudfront.net/)  
**Project walkthrough:** [Video demonstration](https://youtu.be/iN1GmdFdWw8)

> The links reflect the original project deployment and demonstration. Live availability depends on the underlying AWS resources and configuration.

## Key features

**Student experience**
- Sign in through Amazon Cognito with role-based access.
- Submit an issue with a title, type, location, description, and photo.
- Pin the approximate issue location using Amazon Location Service.
- Receive AI-assisted image verification for supported issue types using Rekognition Custom Labels.
- Browse a community report feed and follow personal reports through different statuses.

**Staff experience**
- Access a staff dashboard and review queue.
- Review evidence, assign priority, and update report status.
- Provide staff updates and manage submitted reports.
- Trigger Amazon SNS notifications for new reports and updates.

## Technology stack

| Layer | Technologies |
| --- | --- |
| Frontend | HTML, CSS, vanilla JavaScript |
| Hosting and delivery | Amazon S3, Amazon CloudFront |
| Authentication and roles | Amazon Cognito, API Gateway JWT authorizer |
| API and business logic | Amazon API Gateway, AWS Lambda (JavaScript and Python) |
| Database | Amazon RDS for MySQL |
| Image storage and AI | Amazon S3, Amazon Rekognition Custom Labels |
| Maps | Amazon Location Service |
| Notifications | Amazon SNS |
| Permissions | AWS Identity and Access Management (IAM) |

## Architecture

```text
Student / Staff browser
       |
       +--> CloudFront --> S3 (static website)
       |
       +--> Cognito (authentication)
       |
       +--> API Gateway (JWT authorization)
                       |
                       +--> Reports Lambda --> RDS MySQL
                       |                   +--> Amazon SNS
                       |
                       +--> Image Lambda --> S3 (report images)
                                            +--> Rekognition Custom Labels

Browser --> Amazon Location Service (map / location selection)
```

The static frontend is delivered through CloudFront. Authenticated API requests flow through API Gateway to Lambda functions. Report data is kept in RDS MySQL and photos in S3; Rekognition provides image classification for supported issue categories.

## Repository structure

```text
NexSafe-Cloud-Technologies-for-AI/
├── README.md
├── docs/                 # Project report and presentation
└── src/
    ├── css/              # Page styles
    ├── js/               # Frontend JavaScript and AWS API integration
    ├── backend/          # Original Lambda source exports (.txt)
    ├── index.html         # Landing page
    ├── auth.html          # Sign-in page
    ├── home.html          # Role-based dashboard
    ├── feed.html          # Community report feed
    ├── report.html        # Issue submission
    ├── myreports.html     # Student report tracking
    ├── review.html        # Staff review queue
    └── manage.html        # Staff report management
```

> The backend `.txt` exports are retained as project artifacts. The JavaScript Reports API export also includes a `package.json` excerpt; split these into their respective runtime files before trying to redeploy.

## Running or redeploying

This repository preserves the project source and documentation, **not** the provisioned AWS environment. To fully redeploy, you need an AWS account and configured resources for S3, CloudFront, Cognito, API Gateway, Lambda, RDS MySQL, Rekognition Custom Labels, SNS, Amazon Location, and IAM.

The frontend currently refers to the original project's Cognito and API Gateway settings. Update these for any new deployment. Configure database credentials, bucket settings, model ARN, and SNS topic ARNs through Lambda environment variables or an appropriate secrets-management service; **never commit passwords, secret keys, or token files**.

See the report in [`docs/`](docs/) for architecture, service setup, deployment, testing, and security details.

## Documentation

- **Project report:** full design, AWS service descriptions, deployment process, testing, and lessons learned (in [`docs/`](docs/)).
- **Presentation:** project overview and demonstration slides (in [`docs/`](docs/)).
- **Video:** [NexSafe demo](https://youtu.be/iN1GmdFdWw8)

## Future improvements

Possible next steps include refining accessibility and mobile usability, automating deployment, extending image-model coverage, and strengthening production security and monitoring.

## Project status

**Academic project / original AWS deployment.** The source is archived for learning, demonstration, and future development. The GitHub repository does not contain a backup of AWS-hosted database records, Cognito users, S3 objects, or Rekognition models.
