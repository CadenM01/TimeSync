# TimeSync
A schedule matching calendar app focused on helping students quickly compare schedules and find meetup times.

## Local run
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
export MONGODB_URI="your_uri"
export MONGODB_DB="timesync"
python app.py
```

## EC2 + GitHub Actions deploy (assignment setup)

This repo includes:
- `run.sh` (remote deploy script on EC2)
- `.github/workflows/deploy.yml` (auto deploy on push to `main`)

### 1. One-time EC2 setup
On EC2 (Ubuntu):
```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip
cd ~
git clone https://github.com/CadenM01/TimeSync.git
cd TimeSync
cp .env.example .env
```

Edit `.env` with real values:
- `MONGODB_URI=...`
- `MONGODB_DB=timesync`
- `PORT=8080`

Then run:
```bash
chmod +x run.sh
./run.sh
```

App URL:
`http://<EC2_PUBLIC_IP>:8080`

### 2. EC2 Security Group
Open inbound:
- `22` (SSH) from your IP
- `8080` (Custom TCP) from `0.0.0.0/0` for grading/public access

### 3. MongoDB Atlas Network Access
Allow your EC2 public IP (or temporary `0.0.0.0/0` for demo).

### 4. GitHub repo secrets (for CI/CD)
GitHub -> Settings -> Secrets and variables -> Actions -> New repository secret:
- `EC2_HOST` = EC2 public IP
- `EC2_USER` = `ubuntu`
- `EC2_SSH_KEY` = contents of your `.pem` private key

After this, every push to `main` auto-deploys.
