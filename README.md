# TimeSync

TimeSync is a full-stack scheduling app for comparing two schedules and quickly identifying overlapping open time.

## Features
- Create and manage `My Schedule` and named `Comparison Schedules`
- Visual weekly calendar with busy and open-time blocks
- Save/load profiles and schedules with MongoDB Atlas persistence
- Import a friend schedule by user ID

## Tech Stack
- Backend: Flask (Python)
- Frontend: HTML, CSS, JavaScript
- Database: MongoDB Atlas
- Deployment: AWS EC2 + GitHub Actions

## Environment Variables
Create a `.env` file in the project root:

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>/<db>?retryWrites=true&w=majority
MONGODB_DB=timesync
PORT=8080
```

## Run Locally
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open: `http://127.0.0.1:8080`

## Deploy (EC2)
```bash
chmod +x run.sh
./run.sh
```

Open: `http://<EC2_PUBLIC_IP>:8080`

## CI/CD
This repo includes `.github/workflows/deploy.yml` to auto-deploy on push to `main`.

Required GitHub Secrets:
- `EC2_HOST`
- `EC2_USER`
- `EC2_SSH_KEY`
