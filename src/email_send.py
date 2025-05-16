import smtplib
import pandas as pd
import time
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from smtplib import SMTPException
from dotenv import load_dotenv
import os

# Load environment variables
load_dotenv()
sender_email = os.getenv('SMTP_EMAIL')
sender_password = os.getenv('SMTP_PASSWORD')

# Config
smtp_server = 'smtp.gmail.com'
smtp_port = 587
csv_path = '../scraper.csv'
delay_between_emails = 5  # seconds

# Load CSV
df = pd.read_csv(csv_path)

# Connect to SMTP server
server = smtplib.SMTP(smtp_server, smtp_port)
server.starttls()
server.login(sender_email, sender_password)

# Send emails
for index, row in df.iterrows():
    recipient = row['email']
    subject = row['subject']
    body = row['body']

    msg = MIMEMultipart()
    msg['From'] = sender_email
    msg['To'] = recipient
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain'))

    for attempt in range(3):
        try:
            server.send_message(msg)
            print(f"✅ Sent to {recipient}")
            break
        except SMTPException as e:
            print(f"⚠️ Attempt {attempt+1} failed for {recipient}: {e}")
            time.sleep(2 ** attempt)  # Retry with backoff
    else:
        print(f"❌ Giving up on {recipient} after 3 attempts.")

    time.sleep(delay_between_emails)

server.quit()
