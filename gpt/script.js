
function register(){

let name = document.getElementById("name").value
let email = document.getElementById("email").value
let password = document.getElementById("password").value

let user = {
name:name,
email:email,
password:password
}

localStorage.setItem("user",JSON.stringify(user))

alert("Account created!")

window.location="login.html"

}



function login(){

let email=document.getElementById("loginEmail").value
let password=document.getElementById("loginPassword").value

let user=JSON.parse(localStorage.getItem("user"))

if(email===user.email && password===user.password){

alert("Login successful")

window.location="dashboard.html"

}

else{

alert("Invalid login")

}

}



function saveProfile(){

let name=document.getElementById("profileName").value

localStorage.setItem("profileName",name)

alert("Profile saved")

}



function generateMatches(){

let input=document.getElementById("jobInput").value

if(input.length>0){

document.getElementById("results").classList.remove("hidden")

}

}



function copyResume(){

let text=document.getElementById("resumeText").innerText

navigator.clipboard.writeText(text)

alert("Resume text copied!")

}